'use strict';

// AI requests are opt-in. The ordinary local workflow never calls the API.
let aiSelection = null;
let aiPreview = null;
let aiDisplayed = null;

function aiPanel(c) {
  const results = c.ai_results || [];
  return `<div class="panel box ai-panel"><div class="box-title"><strong>✦ AI 분석 보조 <small>${results.length}</small></strong><button class="small-action" type="button" data-action="ai-open">분석 요청 →</button></div>
    ${results.length ? results.map(r=>`<div class="ai-result-row"><div><b>${r.mode==='verify'?'주장 검토':'자료 분석'}</b><small>${h(fmt(r.created_at))} KST · ${h(r.model)}${r.web_search?' · 웹 검색 허용':''}</small></div><button class="small-action" type="button" data-action="ai-result" data-id="${h(r.id)}">결과 보기</button></div>`).join('') : '<div class="box-empty">선택한 자료를 OpenAI에 보내 분석합니다. 전송 전 내용을 확인할 수 있습니다.</div>'}</div>`;
}

function aiCaptureSelection() {
  const form=$('#ai-request-form');
  if(!form || !state.current) return;
  const fd=new FormData(form);
  aiSelection={case_id:state.current.id, mode:fd.get('mode'), model:fd.get('model'), question:fd.get('question'),
    source_version_ids:fd.getAll('source_version_ids'), claim_ids:fd.getAll('claim_ids'), web_search:fd.get('web_search')==='on'};
}

async function aiSettingsModal() {
  aiCaptureSelection();
  const status=await api('/api/ai/status');
  const body=`<div class="ai-notice">${status.key_ready?'현재 실행 중인 프로그램에 API 키가 설정되어 있습니다.':'아직 이 실행 세션에 API 키가 설정되지 않았습니다.'}<br>키는 이 컴퓨터의 프로그램 메모리에만 보관하며 프로그램을 종료하면 사라집니다. 채팅에 키를 입력하지 마세요.</div><br>
    <label class="field"><span>OpenAI API 키</span><input type="password" name="key" autocomplete="off" spellcheck="false" placeholder="sk-..." required><small>ChatGPT 로그인과 별도의 OpenAI API 키가 필요합니다. 키를 저장하는 것만으로 분석 요청을 보내지는 않습니다.</small></label>
    <a class="ai-model-link" href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">OpenAI API 키 관리 페이지 열기 ↗</a>`;
  const remove=status.key_ready?'<button type="button" class="button button-danger left" data-action="ai-forget">키 지우기</button>':'';
  showModal('AI 연결 설정','선택한 자료를 OpenAI API로 분석할 때 사용할 키입니다.',body,remove+cancelButton+'<button type="submit" class="button button-primary">이번 실행에 사용</button>','ai-key-form');
}

function aiRequestModal(status) {
  const c=state.current;
  if(!c) return;
  const old=aiSelection?.case_id===c.id?aiSelection:{case_id:c.id,mode:'analysis',model:'gpt-6.1-sol',question:'',source_version_ids:[],claim_ids:[],web_search:false};
  const versions=c.sources.flatMap(s=>s.versions.map(v=>({s,v})));
  const sourceList=versions.length ? versions.map(({s,v})=>`<label class="ai-choice"><input type="checkbox" name="source_version_ids" value="${h(v.id)}"${checked(old.source_version_ids.includes(v.id))}><span><strong>${h(s.title)} · v${v.version}</strong><small>${h(s.sensitivity)} · ${s.kind==='file'?`${h(v.original_name)} · ${(v.size/1024/1024).toFixed(2)} MB`:s.kind==='link'?'링크와 메모':'메모 전체'}</small></span></label>`).join('') : '<div class="box-empty">등록된 자료가 없습니다. 질문만 입력할 수도 있습니다.</div>';
  const claimList=c.claims.length ? c.claims.map(cl=>`<label class="ai-choice"><input type="checkbox" name="claim_ids" value="${h(cl.id)}"${checked(old.claim_ids.includes(cl.id))}><span><strong>${h(cl.text)}</strong><small>${h(cl.status)} · ${h(cl.permission)}</small></span></label>`).join('') : '<div class="box-empty">등록된 주장이 없습니다. 검토할 문장을 질문에 직접 입력할 수 있습니다.</div>';
  const body=`<div class="ai-notice">${status?.key_ready?'API 키가 이번 실행에 설정되어 있습니다.':'API 키가 설정되지 않았습니다. 전송 전에 AI 연결에서 입력해 주세요.'} <button type="button" class="small-action" data-action="ai-settings">AI 연결 설정</button><br>선택한 정보는 전송 전 다음 화면에서 확인합니다. AI가 확인 상태를 자동으로 바꾸지 않습니다.</div><br>
    <div class="two-fields"><label class="field"><span>작업</span><select name="mode"><option value="analysis"${selected('analysis',old.mode)}>자료 분석</option><option value="verify"${selected('verify',old.mode)}>주장 검토</option></select></label>${field('모델 ID','model',old.model,'예: gpt-6.1-sol','required maxlength="120"')}</div>
    <a class="ai-model-link" href="https://developers.openai.com/api/docs/models" target="_blank" rel="noopener noreferrer">모델 및 API 사용료 확인 ↗</a>
    ${textarea('추가로 확인할 질문','question',old.question,'예: 발표 수치의 분모와 비교 기간이 일치하는지 확인해 주세요.',3)}
    <div class="field-label">보낼 자료 버전 선택 · 기본 선택 없음</div><div class="ai-selection">${sourceList}</div>
    <div class="field-label">보낼 주장 선택 · 기본 선택 없음</div><div class="ai-selection">${claimList}</div><p class="source-meta">주장에 연결된 원자료는 자동으로 전송되지 않습니다. 대조할 자료 버전도 위에서 따로 선택하세요.</p>
    <label class="ai-choice"><input type="checkbox" name="web_search"${checked(old.web_search)}><span><strong>공개 웹 검색 허용</strong><small>선택한 요청 내용이 검색 질의에 반영될 수 있으며 검색 도구 비용이 추가될 수 있습니다. 끄면 링크 주소만 전달하고 본문을 자동으로 열지 않습니다.</small></span></label>
    <p class="source-meta">PDF·TXT·DOCX·PPTX·XLSX·CSV 등 지원. HWP/HWPX는 PDF로 변환해 등록하세요. 파일은 개당 10MB, 합계 20MB까지 전송합니다.</p>`;
  showModal('AI 분석 요청','전송할 정보와 작업을 직접 고릅니다.',body,cancelButton+'<button type="submit" class="button button-primary">전송 내용 미리보기</button>','ai-request-form');
}

function aiPreviewModal(preview) {
  aiPreview=preview;
  const files=preview.files.filter(f=>f['종류']==='파일');
  const body=`<div class="ai-notice ai-warn"><strong>아래 내용과 선택한 파일 전체가 인터넷을 통해 OpenAI로 전송됩니다.</strong><br>취재원 정보, 비공개 메모와 엠바고 내용을 다시 확인해 주세요. 요청 시 API 사용료가 발생할 수 있습니다.<br>응답 저장 옵션을 끄더라도 OpenAI의 안전·운영 목적 보관 등 데이터 정책이 적용될 수 있습니다. <a href="https://developers.openai.com/api/docs/guides/your-data" target="_blank" rel="noopener noreferrer">데이터 정책 확인 ↗</a></div><br>
    <div class="source-meta">모델 ${h(preview.model)} · ${preview.web_search?'공개 웹 검색 허용':'공개 웹 검색 사용 안 함'} · 파일 ${preview.file_count}개 · ${(preview.file_bytes/1024/1024).toFixed(2)} MB</div><br>
    ${files.length?`<div class="modal-section">함께 전송할 파일 원본 전체</div>${files.map(f=>`<div class="ai-choice"><span><strong>${h(f['파일명'])}</strong><small>${h(f['자료명'])} v${h(f['버전'])} · ${h(f['공개 범위'])}<br>SHA-256 ${h(f['SHA-256'])}</small></span></div>`).join('')}<p class="source-meta">파일 본문은 이 미리보기에 표시하지 않지만 전체 파일을 전송합니다.</p><br>`:''}
    <div class="modal-section">질문·자료 설명·메모·선택 주장 전체</div><pre class="ai-preview-text">${h(preview.text)}</pre>
    <details class="version-row"><summary>함께 전송할 공통 분석 지침 보기</summary><pre class="ai-preview-text">${h(preview.instructions)}</pre></details><br>
    <label class="check"><input type="checkbox" name="confirmed" required> 위 전송 범위와 공개 웹 검색 설정을 확인했습니다.</label>
    <p class="source-meta">확인 내용은 10분 동안 유효합니다. 결과는 이 취재 건에 로컬 저장됩니다.</p>`;
  showModal('OpenAI 전송 확인','확인 후에만 자료를 전송합니다.',body,'<button type="button" class="button" data-action="ai-back">다시 선택</button><button type="submit" class="button button-primary">확인하고 분석 요청</button>','ai-send-form');
}

function aiValidLink(url) {
  try { const parsed=new URL(url); return ['http:','https:'].includes(parsed.protocol) ? parsed.href : ''; }
  catch { return ''; }
}
function aiRenderPart(part) {
  const chars=Array.from(String(part.text||''));
  const citations=(part.citations||[]).map(a=>({...a, safe:aiValidLink(a.url)})).filter(a=>a.safe);
  const positions=new Map(); const extra=[];
  for(const citation of citations) {
    const end=citation.end_index;
    if(Number.isInteger(end) && end>=0 && end<=chars.length) {
      if(!positions.has(end))positions.set(end,[]);
      positions.get(end).push(citation);
    } else extra.push(citation);
  }
  const link=a=>` <a href="${h(a.safe)}" target="_blank" rel="noopener noreferrer">[출처: ${h(a.title||a.safe)} ↗]</a>`;
  let out=''; let last=0;
  [...positions.keys()].sort((a,b)=>a-b).forEach(pos=>{out+=h(chars.slice(last,pos).join(''));out+=positions.get(pos).map(link).join('');last=pos;});
  out+=h(chars.slice(last).join(''));
  if(extra.length)out+='\n'+extra.map(link).join(' ');
  return `<div class="ai-answer">${out}</div>`;
}

function aiResultModal(record) {
  aiDisplayed=record;
  const data=record.result || {};
  const usage=data.usage || {};
  const usageText=Number.isInteger(usage.input_tokens)?`입력 ${usage.input_tokens.toLocaleString()} 토큰 · 출력 ${(usage.output_tokens||0).toLocaleString()} 토큰`: '토큰 사용량 정보 없음';
  const body=`<div class="ai-notice ai-warn">AI 답변은 확인 후보입니다. 원문 위치, 인용, 수치와 독립 출처는 기자가 직접 확인해야 합니다. 기사나 검증 상태에는 자동 반영되지 않습니다.</div>
    ${data.status && data.status!=='completed'?`<p class="form-error">응답 상태: ${h(data.status)}. 내용이 완결되지 않았을 수 있습니다.</p>`:''}
    ${record.saved===false?'<p class="form-error">취재 건을 찾지 못했거나 저장에 실패해 결과가 로컬에 저장되지 않았습니다. 닫기 전에 필요한 내용을 복사하세요.</p>':''}
    <p class="source-meta">${h(data.model||record.model||'')} · ${h(usageText)}${record.web_search?' · 공개 웹 검색 허용':''}</p><hr class="modal-separator">
    ${(data.parts||[]).map(aiRenderPart).join('<hr class="modal-separator">')}
    <div class="ai-usage">${record.question?`추가 질문: ${h(record.question)}<br>`:''}${(record.sources||[]).length?`선택 자료: ${record.sources.map(s=>`${h(s['자료명'])} v${h(s['버전'])}`).join(', ')}<br>`:''}API 사용료는 모델과 토큰·도구 사용량에 따라 달라집니다.</div>`;
  showModal(record.mode==='verify'?'AI 주장 검토 결과':'AI 자료 분석 결과','결과는 참고용이며, 출처 링크가 있으면 눌러 원문을 확인하세요.',body,'<button type="button" class="button" data-action="ai-copy">결과 복사</button><button type="button" class="button button-primary" data-action="close-modal">닫기</button>','ai-result-form');
}

document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action]'); if(!button)return;
  const action=button.dataset.action;
  if(!action?.startsWith('ai-'))return;
  try {
    if(action==='ai-settings') await aiSettingsModal();
    else if(action==='ai-forget'){await api('/api/ai/key','DELETE',{});closeModal();toast('API 키와 대기 중인 전송 내용을 지웠습니다.');}
    else if(action==='ai-open'){const status=await api('/api/ai/status');aiRequestModal(status);}
    else if(action==='ai-back'){const status=await api('/api/ai/status');aiRequestModal(status);}
    else if(action==='ai-result'){const record=state.current?.ai_results?.find(r=>r.id===button.dataset.id);if(record)aiResultModal(record);}
    else if(action==='ai-copy'){
      const parts=aiDisplayed?.result?.parts||[];const sources=new Map();
      parts.forEach(part=>(part.citations||[]).forEach(c=>{const url=aiValidLink(c.url);if(url)sources.set(url,c.title||url);}));
      let text=parts.map(p=>p.text).join('\n\n');
      if(sources.size)text+='\n\n[참고 출처]\n'+[...sources].map(([url,title])=>`${title}: ${url}`).join('\n');
      await navigator.clipboard.writeText(text);toast('AI 결과와 출처 주소를 복사했습니다.');
    }
  } catch(err) {if(modal.open)modalError(err);else toast(err.message);}
});

document.addEventListener('submit',async event=>{
  const form=event.target;const id=form.getAttribute('id');
  if(!id?.startsWith('ai-'))return;
  event.preventDefault();
  const submit=form.querySelector('button[type="submit"]');
  try {
    if(id==='ai-key-form'){
      await api('/api/ai/key','POST',{key:form.elements.key.value});
      form.elements.key.value='';
      if(aiSelection?.case_id===state.current?.id)aiRequestModal({key_ready:true});else closeModal();
      toast('API 키가 이번 실행에 설정되었습니다.');
    } else if(id==='ai-request-form'){
      aiCaptureSelection();
      const preview=await api(`/api/cases/${state.current.id}/ai-preview`,'POST',aiSelection);
      aiPreviewModal(preview);
    } else if(id==='ai-send-form'){
      submit.disabled=true;submit.textContent='분석 중…';
      const response=await api('/api/ai/run','POST',{preview_id:aiPreview.preview_id,confirmed:!!form.elements.confirmed.checked});
      let record=null;
      if(response.saved && state.current?.id===response.case_id){await refreshCase();record=state.current.ai_results.find(r=>r.id===response.id);}
      record=record||{mode:aiPreview.mode,model:aiPreview.model,web_search:aiPreview.web_search,sources:aiPreview.files,
                     question:aiSelection?.question||'',result:response.result,saved:response.saved};
      aiResultModal(record);
    }
  } catch(err){modalError(err);if(id==='ai-send-form'){const box=$('.modal-error',modal);if(box)box.innerHTML+=`<div class="source-meta">다시 요청하려면 ‘다시 선택’을 눌러 전송 내용을 다시 확인하세요.</div>`;}}
  finally {if(submit && submit.isConnected){submit.disabled=false;if(id==='ai-send-form')submit.textContent='확인하고 분석 요청';}}
});
