const status = document.querySelector('#status');
let busy = false;
async function run(action) {
  if (busy) return; busy = true;
  document.querySelectorAll('button').forEach(button => button.disabled = true);
  status.textContent = '작업 공간을 열고 있습니다…';
  try { const result = await action(); status.textContent = result.error || ''; }
  catch { status.textContent = '실행하지 못했습니다. 앱을 종료한 뒤 다시 실행해 주세요.'; }
  finally { busy = false; document.querySelectorAll('button').forEach(button => button.disabled = false); }
}
document.querySelector('#local').addEventListener('click', () => run(() => window.desk.local()));
document.querySelector('#cloud').addEventListener('submit', event => { event.preventDefault(); run(() => window.desk.cloud(document.querySelector('#url').value)); });
window.desk.settings().then(settings => { document.querySelector('#url').value = settings.url || ''; });
