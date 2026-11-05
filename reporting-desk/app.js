'use strict';

const state = { token: '', storage: 'local', cases: [], current: null, view: 'today', draftId: null, dirty: false };
const app = document.querySelector('#app');
const modal = document.querySelector('#modal');
const modalContent = document.querySelector('#modal-content');
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const checked = value => value ? ' checked' : '';
const selected = (a,b) => a === b ? ' selected' : '';
const fmt = value => value ? value.replace('T',' ').slice(0,16) : '미지정';
const compact = value => value ? value.replace('T',' ').slice(0,16).replaceAll('-', '.') : '미지정';
const todayKst = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const opt = (values, value) => values.map(x => `<option value="${h(x)}"${selected(x,value)}>${h(x)}</option>`).join('');
const isFormData = x => x instanceof FormData;
const $ = (selector, root=document) => root.querySelector(selector);
const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];

async function api(path, method='GET', data=null) {
  const headers = {};
  if (method !== 'GET') headers['X-Desk-Token'] = state.token;
  const options = {method, headers};
  if (data !== null) {
    if (isFormData(data)) options.body = data;
    else { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(data); }
  }
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '요청을 처리하지 못했습니다.');
  return result;
}

let toastTimer;
function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 3000);
}
function setNav(view) {
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.action === (view === 'all' ? 'all-cases' : 'home')));
}
function confirmLeave() { return !state.dirty || window.confirm('저장하지 않은 원고 수정이 있습니다. 이동하시겠습니까?'); }
function showModal(title, description, body, footer, id='modal-form') {
  modalContent.innerHTML = `<form id="${h(id)}"><div class="modal-head"><div><h2 id="modal-title">${h(title)}</h2>${description ? `<p>${h(description)}</p>` : ''}</div><button class="close" type="button" data-action="close-modal" aria-label="닫기">×</button></div><div class="modal-body"><div class="modal-error"></div>${body}</div><div class="modal-foot">${footer}</div></form>`;
  if (!modal.open) modal.showModal();
}
function modalError(err) { const el = $('.modal-error',modal); if (el) el.innerHTML = `<div class="form-error">${h(err.message)}</div>`; else toast(err.message); }
function closeModal() { if(modal.open) modal.close(); }
const cancelButton = '<button type="button" class="button" data-action="close-modal">취소</button>';
const saveButton = '<button type="submit" class="button button-primary">저장</button>';
function field(label, name, value='', placeholder='', extra='') { return `<label class="field"><span>${h(label)}</span><input name="${h(name)}" value="${h(value)}" placeholder="${h(placeholder)}" ${extra}></label>`; }
function textarea(label,name,value='',placeholder='',rows=3) { return `<label class="field"><span>${h(label)}</span><textarea name="${h(name)}" rows="${rows}" placeholder="${h(placeholder)}">${h(value)}</textarea></label>`; }
function selectField(label,name,options,value) { return `<label class="field"><span>${h(label)}</span><select name="${h(name)}">${opt(options,value)}</select></label>`; }
function embargo(c) {
  if (c.embargo_type === 'time') return `${compact(c.embargo_at)} KST`;
  if (c.embargo_type === 'event') return c.embargo_released ? '사건 해제 확인' : '사건 해제 전';
  return '제한 없음';
}
function embargoClass(c) { return c.embargo_type === 'none' || (c.embargo_type === 'event' && c.embargo_released) ? '' : 'amber'; }

async function refreshCases() { const data = await api('/api/cases'); state.cases = data.cases; $('#nav-count').textContent = state.cases.filter(c=>c.status==='진행 중').length; }
async function home(view='today') {
  if (!confirmLeave()) return;
  state.dirty = false; state.current = null; state.draftId = null; state.view = view;
  await refreshCases(); renderHome();
}
function renderHome() {
  setNav(state.view);
  $('#breadcrumb').textContent = state.view === 'all' ? '모든 취재' : '오늘';
  const active = state.cases.filter(c => c.status === '진행 중');
  const open = active.reduce((n,c)=>n+c.open_claims,0);
  const withDeadline = active.filter(c=>c.due_at).sort((a,b)=>a.due_at.localeCompare(b.due_at));
  const shown = state.view === 'all' ? state.cases : state.cases.filter(c=>c.status==='진행 중' || (c.status==='대기' && c.next_answer && c.next_answer.slice(0,10)<=todayKst()));
  app.innerHTML = `<div class="home-heading"><div><div class="eyebrow">YOUR NEWSROOM, IN ORDER</div><h1>${state.view==='all'?'모든 취재':'오늘의 취재'}</h1><p>마감과 확인할 사실을 한눈에. 다음 행동부터 이어가세요.</p></div><div class="heading-date">모든 시간은 한국시간 기준입니다</div></div>
    <div class="stats"><div class="stat"><div class="stat-top">진행 중인 취재 <span class="stat-icon">▤</span></div><div class="stat-value">${active.length}<small>건</small></div></div><div class="stat"><div class="stat-top">확인할 주장 <span class="stat-icon">✓</span></div><div class="stat-value">${open}<small>건</small></div></div><div class="stat"><div class="stat-top">가장 빠른 마감 <span class="stat-icon">◷</span></div><div class="stat-value text">${withDeadline.length ? h(compact(withDeadline[0].due_at))+' <small>KST</small>' : '마감 미정'}</div></div></div>
    <div class="section-header"><div><h2>${state.view==='all'?'전체 취재 건':'마감 순서'}</h2><p>${state.view==='all'?'대기와 완료된 취재도 함께 표시합니다.':'진행 중인 취재와 답변 예정일이 된 대기 건을 표시합니다.'}</p></div><button class="button button-small" data-action="${state.view==='all'?'home':'all-cases'}">${state.view==='all'?'오늘 보기':'전체 보기'} →</button></div>
    <section class="panel case-list" aria-label="취재 건 목록">${shown.length ? `<div class="list-head"><span>취재 건</span><span>작업 종류</span><span>지면 마감</span><span>보도 가능 시각</span><span>다음 행동</span></div>${shown.map(c=>`<button class="case-row" data-action="open-case" data-id="${h(c.id)}"><span><span class="case-title">${h(c.title)}</span><span class="case-sub">${h(c.beat || '출입처 미지정')}<span class="dot-sep">·</span>${h(c.status)}${c.open_claims ? `<span class="dot-sep">·</span>확인 ${c.open_claims}`:''}</span></span><span class="cell">${h(c.work_type || '미지정')}</span><span class="cell ${c.due_at?'':'cell-muted'}"><strong>${h(compact(c.due_at))}</strong>${c.due_at?' KST':''}</span><span class="cell">${h(embargo(c))}</span><span class="cell action-cell"><span class="action-dot"></span><span class="action-text">${h(c.next_action || '다음 행동을 정해 주세요')}</span></span></button>`).join('')}` : `<div class="empty"><div class="empty-symbol">▤</div><strong>아직 표시할 취재가 없습니다</strong><p>메모 한 줄로 시작하고, 자료와 마감은 나중에 채울 수 있습니다.</p><button class="button button-primary" data-action="new-case">＋ 새 취재 시작하기</button></div>`}</section>
    <div class="hint-line">${state.storage === 'cloud' ? '기록은 공유 서버에 저장됩니다. 다른 기기의 변경 내용은 새로고침하면 반영됩니다.' : '기록은 이 PC에 저장됩니다.'} <span class="dot-sep">·</span> 확인 상태와 공개 범위는 직접 결정합니다. <span class="dot-sep">·</span><button class="small-action" type="button" data-action="import-backup">백업 복원</button></div>`;
}
async function openCase(id, draftId=null) {
  if (state.current && state.current.id !== id && !confirmLeave()) return;
  state.current = await api(`/api/cases/${id}`); state.view='case'; state.dirty=false;
  state.draftId = draftId && state.current.drafts.some(d=>d.id===draftId) ? draftId : state.current.drafts[0]?.id;
  renderCase();
}
async function refreshCase() {
  const buffered = state.dirty && $('#draft-form') ? draftData() : null;
  state.current = await api(`/api/cases/${state.current.id}`);
  if (buffered) { const draft=state.current.drafts.find(d=>d.id===state.draftId); if(draft) Object.assign(draft,buffered,{revision:buffered.base_revision}); }
  renderCase();
  if (buffered) { state.dirty=true; $('#save-state').textContent='저장 전 변경 있음'; }
}
function claimPicker(name, ids) {
  const claims=state.current.claims;
  return `<details class="claim-picker"><summary>연결 주장 ${ids.length}개 ▾</summary><div class="picker-list">${claims.length ? claims.map(c=>`<label><input type="checkbox" name="${h(name)}" value="${h(c.id)}"${checked(ids.includes(c.id))}> <span>${h(c.text)}</span></label>`).join('') : '먼저 주장을 등록해 주세요.'}</div></details>`;
}
function sourceCard(s) {
  return `<div class="source-item"><div class="source-name">${h(s.title)}</div><div class="source-meta">${s.kind==='file'?'파일':s.kind==='link'?'링크':'메모'} · ${h(s.sensitivity)} · 버전 ${s.versions.length}개</div><div class="source-controls"><button class="small-action" type="button" data-action="source-info" data-id="${h(s.id)}">내용 보기</button><button class="small-action" type="button" data-action="source-version" data-id="${h(s.id)}">＋ 새 버전</button></div></div>`;
}
function evidenceLink(e) {
  const label = `${e.source_title} v${e.version} · ${e.location || '위치 미지정'}`;
  if(e.source_kind==='file') {
    const match = (e.location || '').match(/(?:쪽|p(?:age)?\.?\s*)\s*(\d+)|(\d+)\s*쪽/i); const page = match ? (match[1]||match[2]) : '';
    return `<a href="/api/files/${h(e.source_version_id)}${page ? '#page='+h(page):''}" target="_blank" rel="noopener">${h(label)} ↗</a>`;
  }
  if(e.source_kind==='link' && e.url) return `<a href="${h(e.url)}" target="_blank" rel="noopener noreferrer">${h(label)} ↗</a>`;
  return `<button type="button" class="small-action" data-action="source-info" data-id="${h(e.source_id)}">${h(label)}</button>`;
}
function claimCard(c) {
  const statusClass = c.needs_review || c.status==='자료 상충' || c.status==='보류' ? 'red' : c.status==='확인 대기' ? 'amber' : 'green';
  return `<article class="claim"><div class="claim-title">${h(c.text)}</div><div class="claim-tags"><span class="pill ${statusClass}">${c.needs_review?'재확인 필요':h(c.status)}</span><span class="pill">${h(c.permission)}</span></div>
    ${c.evidence.length ? `<div class="evidence-list">${c.evidence.map(e=>`<div class="evidence">${evidenceLink(e)} <button class="remove" type="button" data-action="remove-evidence" data-id="${h(e.id)}" title="근거 연결 삭제" aria-label="근거 연결 삭제">×</button>${e.excerpt?`<br>${h(e.excerpt)}`:''}</div>`).join('')}</div>` : '<div class="source-meta">연결된 근거가 없습니다.</div>'}
    ${c.next_question ? `<div class="question">↳ ${h(c.next_question)}${c.respondent?`<br>${h(c.respondent)}`:''}${c.answer_due?` · ${h(compact(c.answer_due))}까지`:''}</div>` : ''}
    <div class="source-controls"><button class="small-action" type="button" data-action="edit-claim" data-id="${h(c.id)}">판단 수정</button><button class="small-action" type="button" data-action="add-evidence" data-id="${h(c.id)}">＋ 근거 연결</button></div></article>`;
}
function draftBlock(block, i) {
  return `<div class="draft-field block" data-index="${i}"><label class="field"><span>문단 ${i+1}</span><textarea class="block-text" rows="5" placeholder="원고를 입력하세요. 문단마다 공개 여부와 근거를 정할 수 있습니다.">${h(block.text)}</textarea></label><div class="draft-options"><label class="check"><input type="checkbox" class="block-public"${checked(block.public)}> 외부 공개 승인</label><div>${claimPicker('block-'+i,block.claim_ids || [])} <button type="button" class="small-action" data-action="remove-block" data-index="${i}">삭제</button></div></div></div>`;
}
function draftEditor(draft) {
  if(!draft) return '<div class="panel box box-empty">원고를 추가해 주세요.</div>';
  return `<form id="draft-form" class="panel box"><div class="draft-header"><select class="control" id="draft-select" aria-label="원고 선택">${state.current.drafts.map(d=>`<option value="${h(d.id)}"${selected(d.id,draft.id)}>${h(d.name)}</option>`).join('')}</select><button type="button" class="button button-small" data-action="new-draft">＋ 판 추가</button></div>
    <label class="field"><span>원고 이름</span><input name="name" value="${h(draft.name)}" placeholder="예: 석간 초판"></label>
    <div class="draft-field"><label class="field"><span>제목</span><input name="title" value="${h(draft.title)}" placeholder="제목을 입력하세요"></label><div class="draft-options"><label class="check"><input type="checkbox" name="title_public"${checked(draft.title_public)}> 외부 공개 승인</label>${claimPicker('title-claim',draft.title_claims)}</div></div>
    <div class="draft-field"><label class="field"><span>부제</span><input name="subtitle" value="${h(draft.subtitle)}" placeholder="부제를 입력하세요"></label><div class="draft-options"><label class="check"><input type="checkbox" name="subtitle_public"${checked(draft.subtitle_public)}> 외부 공개 승인</label>${claimPicker('subtitle-claim',draft.subtitle_claims)}</div></div>
    <div id="draft-blocks">${draft.blocks.map(draftBlock).join('')}</div><button type="button" class="small-action" data-action="add-block">＋ 문단 추가</button><span class="dot-sep">·</span><button type="button" class="small-action" data-action="insert-template">기본 구성 넣기</button>
    <div class="draft-field"><label class="field"><span>목표 본문 글자 수</span><input type="number" name="target" min="0" max="1000000" value="${draft.target||''}" placeholder="예: 800"></label><div class="count-row" id="draft-count"></div></div>
    <div class="note">제목·부제·문단을 각각 공개 승인할 수 있습니다. 연결한 주장이 보류 중이거나 자료가 정정되면 외부 출력을 막고 다시 확인하도록 알려줍니다.</div>
    <div class="draft-actions"><button type="button" class="button button-small" data-action="export-internal">내부 검토본</button><button type="button" class="button button-small" data-action="export-external">외부용 출력</button><button type="submit" class="button button-small button-primary" id="draft-save">원고 저장</button></div>
    <details class="version-row"><summary>이전 저장본 ${draft.versions.length}개</summary>${draft.versions.length?draft.versions.map(v=>`<div class="version-item"><span>${h(fmt(v.created_at))} KST</span><button type="button" class="small-action" data-action="restore-draft" data-id="${h(v.id)}">이 저장본 복원</button></div>`).join(''):'<div class="source-meta">원고를 저장하면 이력이 남습니다.</div>'}</details></form>`;
}
function renderCase() {
  const c=state.current; const draft=c.drafts.find(d=>d.id===state.draftId) || c.drafts[0]; state.draftId=draft?.id;
  setNav('today'); $('#breadcrumb').textContent='취재 건';
  app.innerHTML = `<div class="case-heading"><div><button type="button" class="back-link" data-action="home">← 오늘로 돌아가기</button><h1>${h(c.title)}</h1><p>${h(c.next_action || '다음 행동을 정해 두면 오늘 화면에서 바로 확인할 수 있습니다.')}</p><div class="case-meta"><span class="pill blue">${h(c.beat||'출입처 미지정')}</span><span class="pill">${h(c.work_type||'형식 미지정')}</span><span class="pill">마감 ${h(compact(c.due_at))}${c.due_at?' KST':''}</span><span class="pill ${embargoClass(c)}">보도 ${h(embargo(c))}</span><span class="pill">${h(c.status)}</span></div></div><button type="button" class="button" data-action="edit-case">취재 정보 수정</button></div>
    <div class="workspace"><section class="column"><div class="column-head"><h2>자료 <span>SOURCES</span></h2><button type="button" class="small-action" data-action="new-source">＋ 자료 등록</button></div><div class="panel box">${c.sources.length?c.sources.map(sourceCard).join(''):'<div class="box-empty">파일, 링크 또는 취재 메모를 등록하세요.<br>원자료 위치를 주장에 연결할 수 있습니다.</div>'}</div><p class="hint-line">자료에서 쪽수·표·셀·시간 구간을 직접 확인해 근거에 기록하세요.</p><button type="button" class="small-action" data-action="backup-case">↓ 이 취재 건 백업</button></section>
    <section class="column"><div class="column-head"><h2>판단 <span>VERIFICATION</span></h2></div><div class="stack"><div class="panel box"><div class="box-title"><strong>기사 각도를 결정하는 네 줄</strong><button type="button" class="small-action" data-action="edit-angle">수정</button></div>${[['무엇이 바뀌었나',c.angle_change],['왜 이걸 앞세우나',c.angle_why],['지금 어디까지 쓸 수 있나',c.angle_limits],['무엇을 확인하면 방향이 바뀌나',c.angle_shift]].map(([label,value])=>`<div class="angle-line"><small>${h(label)}</small><p>${h(value||'아직 적지 않았습니다.')}</p></div>`).join('')}</div>
    <div class="panel box"><div class="box-title"><strong>주장과 근거 <small>${c.claims.length}</small></strong><button type="button" class="small-action" data-action="new-claim">＋ 주장 추가</button></div>${c.claims.length?c.claims.map(claimCard).join(''):'<div class="box-empty">기사에 쓰려는 사실이나 수치를 한 줄씩 정리하세요.</div>'}</div>${aiPanel(c)}</div></section>
    <section class="column"><div class="column-head"><h2>원고 <span>WRITING</span></h2><span class="source-meta" id="save-state">수동 저장</span></div>${draftEditor(draft)}</section></div>`;
  updateCount();
}

function caseModal(isNew=false) {
  const c=isNew?{title:'',beat:'',work_type:'',due_at:'',embargo_type:'none',embargo_at:'',embargo_event:'',embargo_released:0,next_action:'',status:'진행 중'}:state.current;
  const body = `${field('취재 건 제목 또는 메모 한 줄','title',c.title,'예: 고속철도 통합 이후 이용 변화','required maxlength="300"')}
    <div class="two-fields">${field('출입처','beat',c.beat,'예: 국토교통부')}${field('작업 종류','work_type',c.work_type,'예: 석간 스트레이트')}</div>
    <div class="two-fields">${field('지면 마감 · 한국시간','due_at',c.due_at,'','type="datetime-local"')}${selectField('진행 상태','status',['진행 중','대기','완료'],c.status)}</div>
    <hr class="modal-separator"><div class="modal-section">보도 제한</div><label class="field"><span>엠바고 종류</span><select name="embargo_type" id="embargo-type"><option value="none"${selected('none',c.embargo_type)}>없음</option><option value="time"${selected('time',c.embargo_type)}>정해진 시각</option><option value="event"${selected('event',c.embargo_type)}>사건 발생 시</option></select></label>
    <div id="embargo-time">${field('보도 가능 시각 · 한국시간','embargo_at',c.embargo_at,'','type="datetime-local"')}</div><div id="embargo-event">${field('해제 조건','embargo_event',c.embargo_event,'예: 국무회의 의결 후')}<label class="check"><input type="checkbox" name="embargo_released"${checked(c.embargo_released)}> 사건 발생 및 엠바고 해제를 확인했습니다</label></div>
    <hr class="modal-separator">${field('다음 행동 하나','next_action',c.next_action,'예: 전년 일평균 원집계 요청')}
    ${!isNew?'<div class="danger-zone"><button type="button" class="button button-small button-danger" data-action="delete-case">취재 건과 자료 삭제</button><small class="source-meta"> 연결된 원고와 저장된 파일도 삭제됩니다.</small></div>':''}`;
  showModal(isNew?'새 취재':'취재 정보 수정',isNew?'제목 한 줄로 시작하세요. 다른 항목은 나중에 채워도 됩니다.':'마감과 보도 제한을 별도로 관리합니다.',body,cancelButton+saveButton,'case-form');
  toggleEmbargo();
}
function toggleEmbargo(){ const value=$('#embargo-type')?.value; if($('#embargo-time')) $('#embargo-time').hidden=value!=='time'; if($('#embargo-event')) $('#embargo-event').hidden=value!=='event'; }
function angleModal(){ const c=state.current; showModal('기사 각도','첫 문장에 둘 사실과 방향을 바꿀 확인 사항을 적어 두세요.',
  textarea('무엇이 바뀌었나','angle_change',c.angle_change,'첫 문장에 둘 변화나 검증 결과')+textarea('왜 이걸 앞세우나','angle_why',c.angle_why,'독자에게 미치는 영향이나 새로 확보한 근거')+textarea('지금 어디까지 쓸 수 있나','angle_limits',c.angle_limits,'확인된 사실과 조건을 붙여야 할 내용')+textarea('무엇을 확인하면 방향이 바뀌나','angle_shift',c.angle_shift,'기사화 여부를 가를 확인 사항'),cancelButton+saveButton,'angle-form'); }
function sourceModal(source=null) {
  const isVersion=!!source;
  showModal(isVersion?'자료의 새 버전':'자료 등록',isVersion?'이전 버전은 보존하며 연결된 주장에 재확인 표시가 생깁니다.':'파일, 링크 또는 메모를 이 취재 건에 보관합니다.',
    `${isVersion?`<div class="note">${h(source.title)} · ${h(source.kind==='file'?'파일':source.kind==='link'?'링크':'메모')}</div><br>`:field('자료 이름','title','','예: 부처 보도자료','required')+`<div class="two-fields"><label class="field"><span>자료 종류</span><select name="kind" id="source-kind"><option value="file">파일</option><option value="link">링크</option><option value="memo">메모</option></select></label>${selectField('자료 공개 범위','sensitivity',['내부','공개','취재원 보호'],'내부')}</div>`}
    <div id="source-file"><label class="field"><span>파일 · 최대 50MB</span><input type="file" name="file"><small>원본은 ${state.storage === 'cloud' ? '공유 서버' : '이 PC'}에 보관합니다. 내용을 읽고 근거 위치를 직접 입력해 주세요.</small></label></div>
    <div id="source-link">${field('원문 주소','url','','https://')}</div><div id="source-body">${textarea('메모 또는 자료 설명','body','','내용을 입력하세요.',5)}</div><input type="hidden" name="source_id" value="${h(source?.id||'')}">`,cancelButton+saveButton,'source-form');
  modal.dataset.sourceKind=source?.kind||'file'; toggleSource();
}
function toggleSource(){const kind=$('#source-kind')?.value||modal.dataset.sourceKind; $('#source-file').hidden=kind!=='file'; $('#source-link').hidden=kind!=='link'; $('#source-body').hidden=kind==='file'; }
function sourceInfo(source) {
  const versions=source.versions.map(v=>`<div class="source-item"><div class="source-name">버전 ${v.version} <span class="source-meta">· ${h(fmt(v.created_at))} KST</span></div><div class="source-version">${source.kind==='file'?`<a href="/api/files/${h(v.id)}" target="_blank" rel="noopener">${h(v.original_name)} 열기 ↗</a><br>크기 ${Math.ceil(v.size/1024)} KB`:source.kind==='link'?`<a href="${h(v.url)}" target="_blank" rel="noopener noreferrer">${h(v.url)} ↗</a>`:''}${v.body?`<p>${h(v.body).replace(/\n/g,'<br>')}</p>`:''}</div></div>`).join('');
  showModal('자료 살펴보기','기존 버전과 원문을 보관합니다. 링크를 열면 해당 외부 사이트에 접속합니다.',`${field('자료 이름','title',source.title,'','required')}${selectField('자료 공개 범위','sensitivity',['내부','공개','취재원 보호'],source.sensitivity)}<input type="hidden" name="id" value="${h(source.id)}"><hr class="modal-separator"><div class="modal-section">자료 버전</div>${versions}`,cancelButton+saveButton,'source-info-form');
}
function claimModal(claim=null){
  const c=claim||{text:'',kind:'자료에 적힌 사실',status:'확인 대기',permission:'내부 검토용',comparison:'',calculation:'',next_question:'',respondent:'',answer_due:'',needs_review:0};
  const body=`${textarea('쓰려는 주장','text',c.text,'예: 수서축 이용객이 하루 약 2만 명 늘었다',3)}<div class="two-fields">${selectField('종류','kind',['자료에 적힌 사실','출처의 주장·전망','직접 인용','자체 계산','취재 가설'],c.kind)}${selectField('확인 상태','status',['확인 대기','원문 확인','교차 확인','자료 상충','보류'],c.status)}</div>${selectField('기사에 허용할 표현','permission',['내부 검토용','단정 가능','출처를 밝혀 인용','추정임을 표시','조건부 문장'],c.permission)}
    ${textarea('비교 조건','comparison',c.comparison,'기간·지역·대상·단위·분모·제외 조건 등',2)}${textarea('계산 입력값과 산식','calculation',c.calculation,'예: 90,000 ÷ 1.295. 반올림된 입력값이면 추정으로 표시',2)}
    <hr class="modal-separator"><div class="modal-section">다음 질문</div>${textarea('질문','next_question',c.next_question,'방향을 바꿀 수 있는 질문',2)}<div class="two-fields">${field('담당 기관 또는 역할','respondent',c.respondent,'예: 홍보담당관')}${field('답변 필요 시각 · 한국시간','answer_due',c.answer_due,'','type="datetime-local"')}</div>
    ${claim&&c.needs_review?'<label class="check"><input type="checkbox" name="review_done"> 새 자료를 확인했고 이 주장의 재검토를 마쳤습니다</label>':''}<input type="hidden" name="id" value="${h(claim?.id||'')}">`;
  showModal(claim?'주장 수정':'주장 추가','원문 확인과 독립적인 교차 확인을 구분해 직접 기록합니다.',body,cancelButton+saveButton,'claim-form');
}
function evidenceModal(claim){
  const versions=state.current.sources.flatMap(s=>s.versions.map(v=>({s,v})));
  const body=versions.length?`<label class="field"><span>자료와 버전</span><select name="source_version_id">${versions.map(({s,v})=>`<option value="${h(v.id)}">${h(s.title)} · v${v.version} · ${h(s.sensitivity)}</option>`).join('')}</select></label>${field('원문 위치','location','','예: 3쪽 표 2, B7 셀, 00:04:12')}${textarea('해당 원문 또는 메모','excerpt','','근거를 찾기 쉽게 짧게 기록합니다.',3)}<input type="hidden" name="claim_id" value="${h(claim.id)}">`:'<div class="note">먼저 파일, 링크 또는 메모를 자료로 등록해 주세요.</div>';
  showModal('근거 연결',claim.text,body,cancelButton+(versions.length?saveButton:''),'evidence-form');
}
function draftData(){
  const form=$('#draft-form');
  return {base_revision:state.current.drafts.find(d=>d.id===state.draftId).revision,name:form.elements.name.value,title:form.elements.title.value,subtitle:form.elements.subtitle.value,
    title_public:form.elements.title_public.checked,subtitle_public:form.elements.subtitle_public.checked,
    title_claims:$$('[name="title-claim"]:checked',form).map(x=>x.value),subtitle_claims:$$('[name="subtitle-claim"]:checked',form).map(x=>x.value),
    target:form.elements.target.value,blocks:$$('.block',form).map((b,i)=>({text:$('.block-text',b).value,public:$('.block-public',b).checked,claim_ids:$$(`[name="block-${i}"]:checked`,b).map(x=>x.value)}))};
}
function rerenderBlocks(blocks){$('#draft-blocks').innerHTML=blocks.map(draftBlock).join(''); state.dirty=true; updateCount(); $('#save-state').textContent='저장 전 변경 있음';}
function updateCount(){const form=$('#draft-form'); if(!form)return; const text=$$('.block-text',form).map(x=>x.value).join('\n\n'); const total=Array.from(text).length; const noSpace=Array.from(text.replace(/\s/g,'')).length; const target=form.elements.target.value; $('#draft-count').textContent=`본문 공백 포함 ${total.toLocaleString()}자 · 공백 제외 ${noSpace.toLocaleString()}자 · 원고지 약 ${(total/200).toFixed(1)}매${target?' · 목표 '+Number(target).toLocaleString()+'자':''}`; }
async function saveDraft(force=false){ if(!state.dirty && !force)return; await api(`/api/drafts/${state.draftId}`,'PUT',draftData()); state.dirty=false; await refreshCase(); }
function outputModal(text,mode){
  showModal(mode==='external'?'외부용 출력':'내부 검토본',mode==='external'?'공개 승인한 항목만 포함됩니다. 최종 내용은 기자가 다시 확인하세요.':'보도 제한과 연결된 주장·근거를 함께 표시합니다.',`<textarea class="export-text" id="export-text" aria-label="출력 결과">${h(text)}</textarea>`,`<button type="button" class="button" data-action="copy-output">복사</button><button type="button" class="button button-primary" data-action="download-output">텍스트 파일로 저장</button>`,'output-form');
}
async function exportNow(mode,confirmed=false){const result=await api(`/api/drafts/${state.draftId}/export`,'POST',{mode,confirmed}); outputModal(result.text,mode);}

document.addEventListener('click', async event=>{
  const button=event.target.closest('[data-action]'); if(!button)return;
  const action=button.dataset.action, id=button.dataset.id;
  try {
    if(action==='close-modal') closeModal();
    else if(action==='refresh'){if(!confirmLeave())return;if(state.current){await openCase(state.current.id,state.draftId);}else{await home(state.view);}toast('최신 내용을 불러왔습니다.');}
    else if(action==='home') await home('today');
    else if(action==='all-cases') await home('all');
    else if(action==='new-case') {if(confirmLeave()) caseModal(true);}
    else if(action==='open-case') await openCase(id);
    else if(action==='edit-case') caseModal(false);
    else if(action==='edit-angle') angleModal();
    else if(action==='new-source') sourceModal();
    else if(action==='backup-case'){const a=document.createElement('a');a.href=`/api/cases/${state.current.id}/backup`;a.download='reporting-desk-backup.zip';a.hidden=true;document.body.appendChild(a);a.click();a.remove();toast('백업 파일을 준비합니다. 백업에는 원자료와 취재 메모가 포함됩니다.');}
    else if(action==='import-backup') showModal('취재 건 백업 복원','백업 파일의 취재 건을 별도 복사본으로 복원합니다.',`<label class="field"><span>취재 데스크 백업 ZIP</span><input type="file" name="file" accept=".zip,application/zip" required><small>압축된 백업은 50MB 이하여야 합니다. 백업에는 민감한 원자료가 포함될 수 있습니다.</small></label>`,cancelButton+'<button type="submit" class="button button-primary">복원</button>','import-form');
    else if(action==='source-version') sourceModal(state.current.sources.find(s=>s.id===id));
    else if(action==='source-info') sourceInfo(state.current.sources.find(s=>s.id===id));
    else if(action==='new-claim') claimModal();
    else if(action==='edit-claim') claimModal(state.current.claims.find(c=>c.id===id));
    else if(action==='add-evidence') evidenceModal(state.current.claims.find(c=>c.id===id));
    else if(action==='remove-evidence') {if(confirm('이 주장과 근거의 연결을 삭제할까요? 원자료는 남습니다.')){await api(`/api/evidence/${id}`,'DELETE',{});await refreshCase();toast('근거 연결을 삭제했습니다.');}}
    else if(action==='delete-case') {if(confirm('이 취재 건과 파일·메모·주장·원고를 모두 삭제합니다. 되돌릴 수 없습니다. 삭제할까요?')){await api(`/api/cases/${state.current.id}`,'DELETE',{});closeModal();state.dirty=false;await home('today');toast('취재 건을 삭제했습니다.');}}
    else if(action==='new-draft') {if(state.dirty) await saveDraft();showModal('원고 또는 판 추가','같은 취재 건의 주장과 보도 제한을 공유합니다.',field('원고 이름','name','','예: 석간 최종판','required'),cancelButton+saveButton,'new-draft-form');}
    else if(action==='add-block'){const data=draftData(); data.blocks.push({text:'',public:false,claim_ids:[]});rerenderBlocks(data.blocks);}
    else if(action==='remove-block'){const data=draftData(); if(data.blocks[Number(button.dataset.index)].text && !confirm('이 문단을 삭제할까요? 원고를 저장하기 전에는 변경이 확정되지 않습니다.'))return;data.blocks.splice(Number(button.dataset.index),1);rerenderBlocks(data.blocks);}
    else if(action==='insert-template'){const data=draftData();if(data.blocks.some(b=>b.text.trim())&&!confirm('기본 구성을 원고 끝에 추가할까요?'))return;const text=data.name.includes('발제')?'●(판/형식) 제목(분량)\n- 핵심 변화·수치:\n- 배경·파장:\n- 추가 확인:':'[리드: 확인된 핵심 사실]\n\n[발표·의결 시점과 변화]\n\n[대상·적용 시기]\n\n[인용과 필요한 배경]';if(data.blocks.length===1&&!data.blocks[0].text.trim())data.blocks[0].text=text;else data.blocks.push({text,public:false,claim_ids:[]});rerenderBlocks(data.blocks);}
    else if(action==='restore-draft'){if(confirm('이전 저장본을 현재 원고로 복원할까요? 복원 결과도 새 저장본으로 남습니다.')){await api(`/api/drafts/${state.draftId}/restore/${id}`,'POST',{});state.dirty=false;await refreshCase();toast('이전 저장본을 복원했습니다.');}}
    else if(action==='export-internal'){await saveDraft();await exportNow('internal');}
    else if(action==='export-external'){await saveDraft();showModal('외부용 출력 확인','공개 승인된 제목·부제·문단만 출력합니다.',`<div class="note">${h(state.current.embargo_type==='none'?'이 취재 건에 등록된 엠바고가 없습니다.':`현재 보도 제한: ${embargo(state.current)}`)}</div><br><label class="check"><input type="checkbox" name="confirmed" required> 보도 가능 시점과 각 문장의 공개 범위를 확인했습니다.</label>`,cancelButton+'<button type="submit" class="button button-primary">외부용 본문 보기</button>','external-form');}
    else if(action==='copy-output'){await navigator.clipboard.writeText($('#export-text').value);toast('출력 내용을 복사했습니다.');}
    else if(action==='download-output'){const blob=new Blob(['\ufeff'+$('#export-text').value],{type:'text/plain;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='취재데스크-원고.txt';a.hidden=true;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
  } catch(err) { if(modal.open) modalError(err); else toast(err.message); }
});

document.addEventListener('submit',async event=>{
  event.preventDefault(); const form=event.target; const formId=form.getAttribute('id'); const data=Object.fromEntries(new FormData(form).entries());
  try {
    if(formId==='case-form'){
      data.embargo_released=!!form.elements.embargo_released.checked;
      if(form.querySelector('[data-action="delete-case"]')) {await api(`/api/cases/${state.current.id}`,'PUT',{...state.current,...data}); closeModal(); await refreshCase();toast('취재 정보를 저장했습니다.');}
      else {const result=await api('/api/cases','POST',data);closeModal();state.dirty=false;await refreshCases();await openCase(result.id);toast('새 취재를 만들었습니다.');}
    } else if(formId==='angle-form'){await api(`/api/cases/${state.current.id}`,'PUT',{...state.current,...data});closeModal();await refreshCase();toast('기사 각도를 저장했습니다.');}
    else if(formId==='source-form'){const sourceId=data.source_id;const fd=new FormData(form);await api(sourceId?`/api/sources/${sourceId}/versions`:`/api/cases/${state.current.id}/sources`,'POST',fd);closeModal();await refreshCase();toast(sourceId?'새 버전을 저장하고 연결된 주장을 재확인 대상으로 표시했습니다.':'자료를 저장했습니다.');}
    else if(formId==='source-info-form'){await api(`/api/sources/${data.id}`,'PUT',data);closeModal();await refreshCase();toast('자료 정보를 저장했습니다.');}
    else if(formId==='claim-form'){const original=state.current.claims.find(c=>c.id===data.id); data.needs_review=original?.needs_review&&!form.elements.review_done?.checked;await api(data.id?`/api/claims/${data.id}`:`/api/cases/${state.current.id}/claims`,data.id?'PUT':'POST',data);closeModal();await refreshCase();toast('주장을 저장했습니다. 근거 위치를 연결해 주세요.');}
    else if(formId==='evidence-form'){await api(`/api/claims/${data.claim_id}/evidence`,'POST',data);closeModal();await refreshCase();toast('근거를 연결했습니다.');}
    else if(formId==='import-form'){const result=await api('/api/import','POST',new FormData(form));closeModal();await openCase(result.id);toast('취재 건을 별도 복사본으로 복원했습니다.');}
    else if(formId==='draft-form'){await saveDraft(true);toast('원고와 저장 이력을 기록했습니다.');}
    else if(formId==='new-draft-form'){const result=await api(`/api/cases/${state.current.id}/drafts`,'POST',data);closeModal();await openCase(state.current.id,result.id);toast('새 원고를 만들었습니다.');}
    else if(formId==='external-form'){await exportNow('external',!!form.elements.confirmed.checked);}
  } catch(err){if(form.closest('dialog'))modalError(err);else toast(err.message);}
});
document.addEventListener('change',async event=>{
  if(event.target.id==='embargo-type')toggleEmbargo();
  if(event.target.id==='source-kind')toggleSource();
  if(event.target.id==='draft-select'){const next=event.target.value;if(!confirmLeave()){event.target.value=state.draftId;return;}state.dirty=false;state.draftId=next;renderCase();return;}
  if(event.target.closest('#draft-form')){state.dirty=true;const el=$('#save-state');if(el)el.textContent='저장 전 변경 있음';updateCount();}
});
document.addEventListener('input',event=>{if(event.target.closest('#draft-form')){state.dirty=true;const el=$('#save-state');if(el)el.textContent='저장 전 변경 있음';updateCount();}});
window.addEventListener('beforeunload',event=>{if(state.dirty){event.preventDefault();event.returnValue='';}});
modal.addEventListener('click',event=>{if(event.target===modal)closeModal();});

(async function start(){
  try {
    const config=await api('/api/config');state.token=config.token;state.storage=config.storage || 'local';
    document.querySelector('.sidebar-bottom strong').textContent=state.storage==='cloud'?'공유 서버에 저장 중':'이 PC에 저장 중';
    $('#today-label').textContent=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'long',day:'numeric',weekday:'short'}).format(new Date())+' · KST';
    await home('today');
  } catch(err){app.innerHTML=`<div class="panel empty"><strong>작업 공간을 열지 못했습니다</strong><p>${h(err.message)}</p></div>`;}
})();
