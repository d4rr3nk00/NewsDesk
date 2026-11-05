'use strict';
const {app, BrowserWindow, ipcMain, Menu, dialog, shell, session} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const {pathToFileURL} = require('node:url');
app.setName('NewsDesk');
app.setPath('userData', path.join(app.getPath('appData'), 'NewsDesk'));
let launcher, deskWindow, backend, localOrigin, closing = false;
const pendingAuth = new Map();
const launchURL = pathToFileURL(path.join(__dirname, 'start.html')).href;
const authURL = pathToFileURL(path.join(__dirname, 'auth.html')).href;
const configPath = () => path.join(app.getPath('userData'), 'connection.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}
function validateOrigin(input) {
  const parsed = new URL(String(input).trim());
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('https://desk.example.com 형태의 서버 주소를 입력해 주세요.');
  }
  return parsed.origin;
}
function fromLauncher(event) { return launcher && event.sender.id === launcher.webContents.id && event.senderFrame.url === launchURL; }
function createLauncher() {
  if (launcher && !launcher.isDestroyed()) { launcher.show(); launcher.focus(); return; }
  launcher = new BrowserWindow({width: 820, height: 720, minWidth: 580, minHeight: 620, icon:path.join(__dirname, 'icon.png'),
    backgroundColor: '#f4f6fa', title: '취재 데스크 · 연결',
    webPreferences: {preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true}});
  launcher.loadURL(launchURL);
  launcher.on('closed', () => { launcher = null; });
}
function stopBackend() { if (backend) { backend.kill(); backend = null; localOrigin = null; } }
async function startBackend() {
  if (backend && localOrigin) return localOrigin;
  const payload = app.isPackaged ? path.join(process.resourcesPath, 'payload') : path.resolve(__dirname, '..', '..');
  const python = app.isPackaged ? path.join(process.resourcesPath, 'python', 'python.exe') : (process.env.DESK_PYTHON || 'python');
  const backendScript = app.isPackaged ? path.join(payload, 'backend.py') : path.join(payload, 'desktop', 'backend.py');
  const data = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(data, {recursive:true});
  let errors = '';
  return new Promise((resolve, reject) => {
    const child = backend = spawn(python, ['-u', backendScript], {windowsHide: true, cwd:payload,
      env: {...process.env, REPORTING_DESK_DATA:data, PYTHONUTF8:'1'}, stdio:['ignore','pipe','pipe']});
    let output = '', settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; stopBackend(); reject(new Error('저장소를 시작하지 못했습니다. 앱을 다시 실행해 주세요.')); } }, 20000);
    child.stderr.on('data', data => { errors = (errors + data.toString()).slice(-4000); });
    child.stdout.on('data', data => {
      output += data.toString();
      if (settled || !output.includes('\n')) return;
      try {
        const {port} = JSON.parse(output.split('\n')[0]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid backend port');
        localOrigin = `http://127.0.0.1:${port}`;
        settled = true; clearTimeout(timer); resolve(localOrigin);
      } catch (error) { settled = true; clearTimeout(timer); stopBackend(); reject(error); }
    });
    child.on('error', error => { clearTimeout(timer); if (!settled) { settled = true; reject(error); } });
    child.on('exit', () => {
      if (backend === child) { backend = null; localOrigin = null; }
      clearTimeout(timer);
      if (!settled) { settled = true; reject(new Error('로컬 저장소 실행 오류: ' + errors)); }
      else if (!closing && deskWindow && !deskWindow.isDestroyed() && deskWindow.webContents.getURL().startsWith('http://127.0.0.1:')) {
        dialog.showErrorBox('저장소 연결 종료', '앱을 종료한 뒤 다시 실행해 주세요. 저장된 자료는 그대로 보관됩니다.');
      }
    });
  });
}
function openDesk(origin, mode) {
  if (deskWindow && !deskWindow.isDestroyed()) throw new Error('현재 작업 창을 닫은 뒤 저장 위치를 변경해 주세요.');
  deskWindow = new BrowserWindow({width:1320, height:900, minWidth:420, minHeight:600, icon:path.join(__dirname, 'icon.png'),
    title: `취재 데스크 · ${mode === 'local' ? '이 PC' : '공유 서버'}`,
    webPreferences:{nodeIntegration:false, contextIsolation:true, sandbox:true, webSecurity:true, partition:'desk-workspace'}});
  const current = deskWindow;
  current.webContents.setWindowOpenHandler(({url}) => { openExternal(url); return {action:'deny'}; });
  current.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) { event.preventDefault(); openExternal(url); }
  });
  current.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3) dialog.showMessageBox(current, {type:'error', message:'서버에 연결하지 못했습니다.', detail:'인터넷 연결과 서버 주소를 확인한 뒤 메뉴에서 새로고침하세요. SSL 인증서 오류는 우회하지 않습니다.'});
  });
  current.webContents.on('will-prevent-unload', async event => {
    const choice = dialog.showMessageBoxSync(current, {type:'question', buttons:['계속 작성','저장하지 않고 닫기'], defaultId:0, cancelId:0, message:'저장하지 않은 원고 변경이 있습니다.'});
    if (choice === 1) event.preventDefault();
  });
  current.on('page-title-updated', event => event.preventDefault());
  current.on('closed', () => {
    deskWindow = null;
    stopBackend();
    if (!closing) app.quit();
  });
  current.loadURL(origin);
  if (launcher) launcher.hide();
}
function openExternal(value) {
  try { const url = new URL(value); if (['https:','http:'].includes(url.protocol)) shell.openExternal(url.href); } catch {}
}
ipcMain.handle('settings', event => { if (!fromLauncher(event)) throw new Error('Access denied'); return readSettings(); });
ipcMain.handle('open-local', async event => {
  if (!fromLauncher(event)) throw new Error('Access denied');
  try { const origin = await startBackend(); openDesk(origin, 'local'); return {ok:true}; }
  catch(error) { return {error:error.message}; }
});
ipcMain.handle('open-cloud', async (event, value) => {
  if (!fromLauncher(event)) throw new Error('Access denied');
  try {
    const origin = validateOrigin(value); openDesk(origin, 'cloud');
    fs.writeFileSync(configPath(), JSON.stringify({url:origin}));
    return {ok:true};
  } catch(error) { return {error:error.message}; }
});
ipcMain.handle('credentials', (event, value) => {
  const request = pendingAuth.get(event.sender.id);
  if (!request || event.senderFrame.url !== authURL) throw new Error('Access denied');
  pendingAuth.delete(event.sender.id);
  request.callback(String(value.username || ''), String(value.password || ''));
  request.window.close();
});
app.on('login', (event, contents, _request, authInfo, callback) => {
  if (!deskWindow || contents.id !== deskWindow.webContents.id || authInfo.isProxy) return;
  event.preventDefault();
  const authWindow = new BrowserWindow({parent:deskWindow, modal:true, width:440, height:400, resizable:false,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  authWindow.setMenu(null);
  const id = authWindow.webContents.id;
  pendingAuth.set(id, {window:authWindow,callback});
  authWindow.on('closed', () => { if (pendingAuth.has(id)) { pendingAuth.delete(id); callback(); } });
  authWindow.loadURL(authURL);
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { const window = deskWindow || launcher; if (window) { window.show(); if(window.isMinimized())window.restore(); window.focus(); } });
  app.whenReady().then(() => {
    const workspaceSession = session.fromPartition('desk-workspace');
    workspaceSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
    workspaceSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write');
    session.fromPartition('desk-workspace').on('will-download', (_event, item) => {
      item.setSaveDialogOptions({title:'취재 자료 저장'});
      item.once('done', (_e, state) => { if (state !== 'completed' && state !== 'cancelled') dialog.showErrorBox('다운로드 실패', '파일을 저장하지 못했습니다. 연결 상태와 저장 위치를 확인해 주세요.'); });
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label:'취재 데스크', submenu:[{label:'저장 위치 안내', click:()=>dialog.showMessageBox({message:'이 PC 저장과 공유 서버 저장은 별도입니다.',detail:'PC 자료 폴더: '+path.join(app.getPath('userData'),'data')+'\n공유 서버로 옮기려면 취재별 ZIP 백업·복원을 사용하세요. 연결 방식을 바꾸려면 앱을 종료하고 다시 실행하세요.'})},
        {label:'PC 자료 폴더 열기', click:()=>{const p=path.join(app.getPath('userData'),'data');fs.mkdirSync(p,{recursive:true});shell.openPath(p);}}, {type:'separator'}, {role:'quit',label:'종료'}]},
      {label:'편집', submenu:[{role:'undo',label:'실행 취소'},{role:'redo',label:'다시 실행'},{type:'separator'},{role:'cut',label:'잘라내기'},{role:'copy',label:'복사'},{role:'paste',label:'붙여넣기'},{role:'selectAll',label:'모두 선택'}]},
      {label:'보기',submenu:[{label:'새로고침',accelerator:'CmdOrCtrl+R',click:()=>{if(deskWindow)deskWindow.reload();}},{role:'resetZoom',label:'기본 크기'},{role:'zoomIn',label:'확대'},{role:'zoomOut',label:'축소'},{role:'togglefullscreen',label:'전체 화면'}]}
    ]));
    createLauncher();
  });
}
app.on('before-quit', () => { closing = true; });
app.on('will-quit', stopBackend);
app.on('window-all-closed', () => app.quit());
