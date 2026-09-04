/**
 * dsh-tool-lipsync — Client half (browser)
 * -------------------------------------------
 * 通过 DSH 的 client 模块系统（window.__ModuleLoader__.load）嵌入浏览器。
 * apply(ctx) 在 DSH 页面里挂载一个 FreeLipSync 操作面板（右上角浮动按钮 +
 * 抽屉），实现：上传图片/视频、输入文本、上传/录制音频、选模型、免费生成、
 * 最近生成。所有 API 都经由 host 的本地 bridge（127.0.0.1:8790）调用，
 * 因此不消耗模型 token，也绕过了 freelipsync 的 CORS 限制。
 */
window.__ModuleLoader__.load({
  id: 'dsh-tool-lipsync',
  factory: function (require, module) {
    'use strict'

    const name = 'dsh-tool-lipsync'
    const inject = []
    const BRIDGE = 'http://127.0.0.1:8790'

    // ============================================================
    // 状态
    // ============================================================
    // 中文男女声默认 ID（fallback 用）
    const VOICE_FEMALE_ZH = 'faccba1a8ac54016bcfc02761285e67f'  // 温柔动听女声
    const VOICE_MALE_ZH   = '54a5170264694bfc8e9ad98df7bd89c3'  // 丁真

    const state = {
      faceUrl: null,
      faceKind: null,   // 'image' | 'video'
      faceWidth: 1024,
      faceHeight: 1024,
      inputMode: 'text', // text | audio | record
      text: '',
      audioUrl: null,
      model: 'fast',    // fast | max | music
      voiceId: null,
      voiceName: '默认中文',
      defaultVoiceId: VOICE_FEMALE_ZH,
      sampleGender: null,  // 'male' | 'female' | null (from selected sample)
      currentGen: null,
      timer: null,
      // 白标后台元数据
      fc: null,         // frontend-config 结果
      backendInfo: null,
      licensed: (() => { try { return localStorage.getItem('fls_licensed') === '1' } catch { return false } })(),
    }

    // ============================================================
    // 栈安全的 base64 转换（避免大文件展开 ...Uint8Array 导致栈溢出）
    // ============================================================
    function arrayBufferToBase64(buf) {
      const bytes = new Uint8Array(buf)
      let binary = ''
      const CHUNK = 0x8000
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
      }
      return btoa(binary)
    }

    // ============================================================
    // 轻量 DOM helper
    // ============================================================
    function el(tag, attrs) {
      const node = document.createElement(tag)
      if (attrs) {
        for (const k in attrs) {
          if (k === 'class') node.className = attrs[k]
          else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(node.style, attrs[k])
          else if (k === 'text') node.textContent = attrs[k]
          else if (k.startsWith('on') && typeof attrs[k] === 'function') node.addEventListener(k.slice(2).toLowerCase(), attrs[k])
          else if (attrs[k] != null) node.setAttribute(k, attrs[k])
        }
      }
      for (let i = 2; i < arguments.length; i++) {
        const c = arguments[i]
        if (c == null) continue
        const arr = Array.isArray(c) ? c : [c]
        for (const child of arr) { if (child != null) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child) }
      }
      return node
    }

    // ============================================================
    // Bridge 请求
    // ============================================================
    async function bridge(method, path, body) {
      const init = { method, headers: {} }
      if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body) }
      const resp = await fetch(BRIDGE + path, init)
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status))
      return data
    }

    function setLicensed(v) {
      state.licensed = !!v
      try { localStorage.setItem('fls_licensed', state.licensed ? '1' : '0') } catch {}
    }

    // 白标后台是否可用的判定
    function fcUsable() {
      if (!state.fc || !state.fc.configured) return false
      if (state.fc.enabled === false) return false
      if (state.fc.license_required && !state.licensed) return false
      if (state.fc.reg_login_required && !state.backendInfo?.loggedIn) return false
      return true
    }

    // ============================================================
    // CSS（注入 <style>）
    // ============================================================
    const CSS = `
.fls-wrap{font-family:'Sora','Segoe UI',system-ui,sans-serif}
.fls-fab{position:fixed;top:70px;right:16px;z-index:99999;width:52px;height:52px;border-radius:50%;
  background:linear-gradient(135deg,#FFD700,#FDB931);border:none;cursor:pointer;font-size:22px;
  box-shadow:0 6px 20px rgba(255,215,0,.4);display:flex;align-items:center;justify-content:center;
  transition:.25s;color:#111}
.fls-fab:hover{transform:scale(1.08)}
.fls-drawer{position:fixed;top:0;right:0;bottom:0;width:min(420px,96vw);z-index:100000;
  background:#0a0a0a;color:#e8e8e8;border-left:1px solid #262626;transform:translateX(105%);
  transition:transform .3s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column;
  font-size:14px;box-shadow:-10px 0 40px rgba(0,0,0,.6)}
.fls-drawer.open{transform:translateX(0)}
.fls-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #262626;background:#121212;flex-wrap:nowrap;overflow:hidden}
.fls-head .fls-title{font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex-shrink:1;color:#fff}
.fls-head .fls-title em{font-style:normal;background:linear-gradient(90deg,#FFD700,#FFD800);-webkit-background-clip:text;background-clip:text;color:transparent}
.fls-head-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}
.fls-close{background:none;border:none;color:#999;font-size:18px;cursor:pointer;width:26px;height:26px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.fls-close:hover{color:#fff;background:rgba(255,255,255,.08)}
.fls-body{flex:1;overflow-y:auto;padding:14px 16px}
.fls-label{font-size:12px;color:#999;margin:14px 0 8px;display:flex;align-items:center;gap:6px}
.fls-label b{color:#e8e8e8;font-size:13px}
.fls-dropzone{border:2px dashed #333;border-radius:12px;min-height:140px;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:6px;cursor:pointer;text-align:center;padding:16px;
  background:#121212;position:relative;overflow:hidden;transition:.2s}
.fls-dropzone:hover{border-color:#FFD700}
.fls-dropzone .big{font-size:32px;opacity:.6}
.fls-dropzone .t1{font-size:13px;font-weight:600}
.fls-dropzone .t2{font-size:11px;color:#999}
.fls-dzbtn{background:linear-gradient(135deg,#FFD700,#FDB931);color:#111;border:none;padding:7px 18px;border-radius:999px;font-weight:700;cursor:pointer;font-size:12px;margin-top:4px}
.fls-prev{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.75)}
.fls-prev.show{display:flex}
.fls-prev img,.fls-prev video{max-width:100%;max-height:100%;border-radius:8px}
.fls-prev .fls-tag{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.8);padding:3px 10px;border-radius:999px;font-size:11px;color:#FFD700}
.fls-clear{position:absolute;top:6px;right:6px;background:rgba(0,0,0,.7);border:none;color:#fff;width:26px;height:26px;border-radius:50%;cursor:pointer;font-size:14px;z-index:3;display:none}
.fls-hasfile .fls-clear{display:block}
.fls-seg{display:flex;gap:6px;margin-bottom:8px}
.fls-seg button{flex:1;background:#121212;border:1px solid #262626;color:#999;padding:9px;border-radius:9px;cursor:pointer;font-size:12px;transition:.2s}
.fls-seg button.active{color:#FFD700;border-color:#FFD700;background:rgba(255,215,0,.06)}
.fls-textarea{width:100%;min-height:90px;background:#121212;border:1px solid #262626;border-radius:10px;color:#e8e8e8;padding:11px;font-size:13px;resize:vertical;font-family:inherit;box-sizing:border-box}
.fls-textarea:focus{outline:none;border-color:#FFD700}
.fls-hint{font-size:11px;color:#666;margin-top:5px}
.fls-audio-box{display:none}
.fls-audio-box.show{display:block}
.fls-audiofile{width:100%;padding:12px;background:#121212;border:1px dashed #333;border-radius:10px;color:#999;font-size:12px;cursor:pointer;box-sizing:border-box}
.fls-rec{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.fls-recbtn{background:#121212;border:1px solid #262626;color:#e8e8e8;padding:8px 16px;border-radius:999px;cursor:pointer;font-size:12px}
.fls-recbtn.recording{border-color:#ef4444;color:#ef4444;animation:flspulse 1.2s infinite}
@keyframes flspulse{50%{opacity:.5}}
.fls-rectime{font-variant-numeric:tabular-nums;color:#FFD700;font-size:12px}
.fls-modelgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.fls-modelcard{background:#121212;border:1px solid #262626;border-radius:10px;padding:12px;cursor:pointer;text-align:center;transition:.2s}
.fls-modelcard.active{border-color:#FFD700;background:rgba(255,215,0,.06)}
.fls-modelcard .nm{font-weight:700;font-size:14px}
.fls-modelcard .de{font-size:11px;color:#999;margin-top:3px}
.fls-genrow{display:flex;gap:10px;margin-top:16px}
.fls-gen{flex:1;background:linear-gradient(135deg,#FFD700,#FDB931);color:#111;border:none;border-radius:12px;padding:14px;font-size:15px;font-weight:800;cursor:pointer;transition:.2s}
.fls-gen:hover{filter:brightness(1.08)}
.fls-gen:disabled{opacity:.5;cursor:not-allowed}
.fls-voice{background:#121212;border:1px solid #262626;color:#999;border-radius:12px;padding:14px 16px;font-size:12px;cursor:pointer;max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fls-progress{display:none;margin-top:14px;background:#121212;border:1px solid #262626;border-radius:10px;padding:12px}
.fls-progress.show{display:block}
.fls-ptop{display:flex;justify-content:space-between;font-size:12px;color:#999;margin-bottom:6px}
.fls-pbar{height:7px;background:#262626;border-radius:999px;overflow:hidden}
.fls-pfill{height:100%;width:0%;background:linear-gradient(90deg,#FFD700,#FFD800);border-radius:999px;transition:width .5s}
.fls-subtitle{font-size:13px;font-weight:800;margin:20px 0 4px;color:#e8e8e8}
.fls-samples{display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px;margin-top:8px}
.fls-sample{border:1px solid #262626;border-radius:9px;overflow:hidden;cursor:pointer;background:#121212;transition:.2s;position:relative}
.fls-sample:hover{border-color:#FFD700}
.fls-sample.selected{border-color:#FFD700;box-shadow:0 0 0 2px rgba(255,215,0,.3)}
.fls-sample img,.fls-sample video{width:100%;height:90px;object-fit:cover;display:block}
.fls-sample .sn{font-size:10px;padding:5px 6px;color:#999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fls-hist{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.fls-histcard{border:1px solid #262626;border-radius:9px;overflow:hidden;background:#121212;position:relative}
.fls-histcard video,.fls-histcard img{width:100%;height:90px;object-fit:cover;display:block;background:#000}
.fls-histbody{padding:7px 9px}
.fls-histtext{font-size:11px;color:#999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px}
.fls-histstatus{font-size:10px;font-weight:700}
.fls-histstatus.ok{color:#22c55e}.fls-histstatus.err{color:#ef4444}.fls-histstatus.wait{color:#FFD700}
.fls-dl{margin-top:6px;width:100%;background:linear-gradient(135deg,#FFD700,#FDB931);border:none;border-radius:7px;padding:6px 0;font-size:12px;font-weight:700;color:#000;cursor:pointer}
.fls-del{position:absolute;top:4px;right:4px;background:rgba(0,0,0,.7);border:none;color:#ef4444;width:24px;height:24px;border-radius:50%;cursor:pointer;font-size:12px;z-index:3;display:flex;align-items:center;justify-content:center}
.fls-del:hover{background:rgba(239,68,68,.3)}
.fls-pager{display:flex;align-items:center;justify-content:center;gap:12px;margin-top:10px;font-size:12px;color:#999}
.fls-pager button{background:#121212;border:1px solid #262626;color:#e8e8e8;padding:6px 14px;border-radius:999px;cursor:pointer;font-size:11px}
.fls-pager button:hover{border-color:#FFD700;color:#FFD700}
.fls-pager button:disabled{opacity:.4;cursor:not-allowed}
.fls-headmenu{background:none;border:1px solid #333;color:#aaa;padding:3px 8px;border-radius:999px;font-size:10px;cursor:pointer;text-decoration:none;white-space:nowrap;flex-shrink:0}
.fls-headmenu:hover{color:#FFD700;border-color:#FFD700}
.fls-user-menu{position:relative;flex-shrink:0}
.fls-user-menu-btn{background:none;border:1px solid #333;color:#aaa;padding:3px 8px;border-radius:999px;font-size:10px;cursor:pointer;white-space:nowrap;max-width:90px;overflow:hidden;text-overflow:ellipsis}
.fls-user-menu-btn:hover{color:#FFD700;border-color:#FFD700}
.fls-empty{color:#666;text-align:center;padding:20px 0;font-size:12px}
.fls-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(80px);background:#1c1c1c;
  border:1px solid #333;color:#e8e8e8;padding:10px 20px;border-radius:999px;font-size:13px;z-index:100001;
  opacity:0;transition:.3s;pointer-events:none;box-shadow:0 8px 30px rgba(0,0,0,.5);max-width:80vw}
.fls-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.fls-toast.err{border-color:#ef4444}.fls-toast.ok{border-color:#22c55e}
.fls-voice-modal{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100002;display:none;align-items:center;justify-content:center}
.fls-voice-modal.show{display:flex}
.fls-gender-modal{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:100003;display:none;align-items:center;justify-content:center}
.fls-gender-modal.show{display:flex}
.fls-gender-panel{background:#1a1a1a;border:1px solid #333;border-radius:12px;width:320px;max-height:80vh;overflow:hidden}
.fls-gender-btns{display:flex;gap:12px;padding:20px;justify-content:center}
.fls-gender-btn{display:flex;flex-direction:column;align-items:center;gap:6px;padding:16px 24px;border:2px solid #333;border-radius:12px;background:#121212;color:#fff;cursor:pointer;font-size:13px;font-weight:600;transition:.2s;min-width:100px}
.fls-gender-btn:hover{border-color:#FFD700;background:rgba(255,215,0,.08)}
.fls-gender-btn.female:hover{border-color:#ff69b4;background:rgba(255,105,180,.08)}
.fls-gender-btn.male:hover{border-color:#4da6ff;background:rgba(77,166,255,.08)}
.fls-voice-panel{background:#121212;border:1px solid #333;border-radius:14px;width:min(360px,90vw);max-height:80vh;display:flex;flex-direction:column}
.fls-voice-list{overflow-y:auto;padding:8px}
.fls-voice-hdr{padding:6px 11px;font-size:11px;color:#FFD700;font-weight:600;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #262626;margin-bottom:4px;position:sticky;top:0;background:#1a1a1a;z-index:1}
.fls-voice-item{padding:9px 11px;border-radius:8px;cursor:pointer;font-size:13px}
.fls-voice-item:hover{background:rgba(255,215,0,.08)}
.fls-voice-item .vl{color:#999;font-size:11px}
.fls-modal-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #262626;font-weight:700;font-size:14px}
.fls-settings{border-top:1px solid #262626;margin-top:16px;padding-top:12px}
.fls-settings summary{cursor:pointer;font-weight:700;font-size:13px;color:#ccc;user-select:none}
.fls-settings .grow{width:100%}
.fls-in{width:100%;background:#121212;border:1px solid #262626;border-radius:8px;color:#e8e8e8;padding:8px 10px;font-size:12px;box-sizing:border-box;margin-top:6px}
.fls-in:focus{outline:none;border-color:#FFD700}
.fls-btn-gold{background:linear-gradient(135deg,#FFD700,#FDB931);color:#111;border:none;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer;font-size:12px;margin-top:8px}
.fls-btn-ghost2{background:#121212;border:1px solid #262626;color:#ccc;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:12px;margin-top:8px}
.fls-gate{background:#141010;border:1px solid #3a2320;border-radius:12px;padding:16px;margin-bottom:12px}
.fls-gate .gt{font-weight:800;font-size:14px;color:#f0a8a0;margin-bottom:6px}
.fls-gate .gd{font-size:12px;color:#999;line-height:1.5}
.fls-gate .gd b{color:#e8e8e8}
.fls-footerlinks{display:flex;gap:10px;font-size:12px;color:#666;padding:12px 16px;border-top:1px solid #1c1c1c;flex-wrap:wrap;align-items:center}
.fls-footerlinks a{color:#888;text-decoration:none;padding:4px 8px;border-radius:4px;transition:all .2s;white-space:nowrap}
.fls-footerlinks a:hover{color:#FFD700;background:rgba(255,215,0,.1)}
.fls-statuspill{font-size:11px;color:#999;padding:2px 8px;border-radius:999px;border:1px solid #262626;margin-left:auto}
.fls-statuspill.ok{color:#22c55e;border-color:#22c55e}
.fls-statuspill.warn{color:#FFD700;border-color:#FFD700}
.fls-daily{font-size:11px;color:#666;margin-top:4px}
.fls-formrow{display:flex;gap:8px;align-items:center;margin-top:8px}
.fls-formrow .fls-in{margin-top:0;flex:1}
`

    // ============================================================
    // 构建 UI
    // ============================================================
    function buildUI(root) {
      // --- FAB 按钮 ---
      const fab = el('button', { class: 'fls-fab', title: 'FreeLipSync 对口型', text: '🎙️' })

      // --- 抽屉 ---
      const drawer = el('div', { class: 'fls-drawer' })
      const titleSpan = el('em', { text: 'FreeLipSync' })
      // 顶部菜单容器（支持多个菜单项）
      const headerMenusBox = el('div', { class: 'fls-header-menus', style: { display: 'flex', gap: '4px', flexWrap: 'wrap', flexShrink: 1, minWidth: 0 } })
      // 用户菜单按钮
      const userMenuBox = el('div', { class: 'fls-user-menu', style: { display: 'none', position: 'relative', flexShrink: 0 } })
      const userMenuBtn = el('button', { class: 'fls-user-menu-btn', style: { display: 'none' } })
      const userDropdown = el('div', { class: 'fls-user-dropdown', style: { display: 'none', position: 'absolute', right: 0, top: '100%', marginTop: '4px', background: '#1a1a2e', border: '1px solid #333', borderRadius: '6px', padding: '4px 0', minWidth: '120px', zIndex: 9999, boxShadow: '0 4px 12px rgba(0,0,0,0.5)' } })
      userMenuBox.appendChild(userMenuBtn)
      userMenuBox.appendChild(userDropdown)
      
      const head = el('div', { class: 'fls-head' },
        el('div', { class: 'fls-title' }, [titleSpan, document.createTextNode(' 对口型面板')]),
        el('div', { class: 'fls-head-actions' }, [headerMenusBox, userMenuBox, el('button', { class: 'fls-close', text: '✕' })])
      )
      const body = el('div', { class: 'fls-body' })

      drawer.appendChild(head)
      drawer.appendChild(body)

      // 打开/关闭
      let open = false
      const setOpen = (v) => {
        open = v
        drawer.classList.toggle('open', v)
        if (v) { refreshBackend(); loadSamples(); loadHistory() }
      }
      fab.addEventListener('click', () => setOpen(!open))
      head.querySelector('.fls-close').addEventListener('click', () => setOpen(false))
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false) })

      // 用户菜单切换
      userMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        userDropdown.style.display = userDropdown.style.display === 'none' ? 'block' : 'none'
      })
      document.addEventListener('click', () => { userDropdown.style.display = 'none' })

      // 修改密码模态框
      function showChangePasswordModal() {
        const overlay = el('div', { style: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 10001, display: 'flex', alignItems: 'center', justifyContent: 'center' } })
        const modal = el('div', { style: { background: '#1a1a2e', border: '1px solid #444', borderRadius: '10px', padding: '20px', width: '320px', maxWidth: '90%' } })
        const title = el('div', { style: { fontSize: '16px', fontWeight: 'bold', marginBottom: '15px', color: '#fff' }, text: '修改密码' })
        const oldPw = el('input', { class: 'fls-in', type: 'password', placeholder: '当前密码', style: { marginBottom: '10px' } })
        const newPw = el('input', { class: 'fls-in', type: 'password', placeholder: '新密码(至少6位)', style: { marginBottom: '10px' } })
        const confirmPw = el('input', { class: 'fls-in', type: 'password', placeholder: '确认新密码', style: { marginBottom: '15px' } })
        const btnRow = el('div', { style: { display: 'flex', gap: '8px' } })
        const cancelBtn = el('button', { class: 'fls-btn-ghost2', type: 'button', text: '取消', style: { flex: 1 } })
        const saveBtn = el('button', { class: 'fls-btn-gold', type: 'button', text: '保存', style: { flex: 1 } })
        btnRow.appendChild(cancelBtn)
        btnRow.appendChild(saveBtn)
        modal.appendChild(title)
        modal.appendChild(oldPw)
        modal.appendChild(newPw)
        modal.appendChild(confirmPw)
        modal.appendChild(btnRow)
        overlay.appendChild(modal)
        document.body.appendChild(overlay)
        
        cancelBtn.addEventListener('click', () => overlay.remove())
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
        saveBtn.addEventListener('click', async () => {
          const old = oldPw.value.trim()
          const np = newPw.value.trim()
          const cp = confirmPw.value.trim()
          if (!old || !np || !cp) { toast('请填写所有字段', 'err'); return }
          if (np.length < 6) { toast('新密码至少6位', 'err'); return }
          if (np !== cp) { toast('两次密码不一致', 'err'); return }
          try {
            await bridge('POST', '/api/change-password', { old_password: old, new_password: np })
            toast('密码修改成功', 'ok')
            overlay.remove()
          } catch (e) { toast('修改失败: ' + e.message, 'err') }
        })
      }

      // 底部菜单占位(白标三入口)
      const footerLinks = el('div', { class: 'fls-footerlinks', style: { display: 'none' } })
      drawer.appendChild(footerLinks)

      // ---------- 设置(后台对接) ----------
      // 后台配置接口保留(bridge 内部维护),但 UI 不再渲染配置栏,
      // 普通用户看到的是纯白标界面(无「后台配置/API Key」入口)。

      // ---------- 每日限额提示(独立于后台配置,始终对用户可见) ----------
      const dailyBox = el('div', { class: 'fls-daily', id: 'fls-daily', style: { display: 'none' } })
      body.appendChild(dailyBox)

      // ---------- 授权/登录门禁 ----------
      const gateBox = el('div', { class: 'fls-gate', style: { display: 'none' } })
      body.appendChild(gateBox)

      function showGate() { gateBox.style.display = '' }
      function hideGate() { gateBox.style.display = 'none' }

      async function refreshBackend() {
        try {
          const [fc, bi] = await Promise.all([
            bridge('GET', '/api/frontend-config').catch(() => ({ configured: false })),
            bridge('GET', '/api/backend').catch(() => ({ configured: false })),
          ])
          state.fc = fc
          state.backendInfo = bi
          // 白标标题
          const t = fc?.title || 'FreeLipSync'
          titleSpan.textContent = t
          fab.title = t + ' 对口型'
          // 顶部菜单（支持多个）
          const headerMenus = (fc?.headerMenus || []).filter(m => m.label && m.url && /^https?:\/\//i.test(m.url))
          headerMenusBox.innerHTML = ''
          headerMenus.forEach(m => {
            const a = el('a', { class: 'fls-headmenu', href: m.url, target: '_blank', rel: 'noopener', text: m.label })
            headerMenusBox.appendChild(a)
          })
          headerMenusBox.style.display = headerMenus.length ? 'flex' : 'none'
          // 底部菜单
          const menus = (fc?.menus || []).filter(m => m.label && m.url)
          footerLinks.innerHTML = ''
          menus.forEach(m => {
            if (!/^https?:\/\//i.test(m.url)) return
            const a = el('a', { href: m.url, target: '_blank', rel: 'noopener', text: m.label })
            footerLinks.appendChild(a)
          })
          footerLinks.style.display = menus.length ? 'flex' : 'none'
          // 每日限额提示
          const d = fc?.daily
          if (d) {
            dailyBox.textContent = `每日限额(每IP · 每注册账号):生成 ${d.gen} / 下载 ${d.dl}`
            dailyBox.style.display = ''
          } else {
            dailyBox.style.display = 'none'
          }
          // 用户菜单
          if (fc?.reg_login_required && bi?.loggedIn) {
            userMenuBtn.textContent = bi.user || '用户'
            userMenuBtn.style.display = ''
            userDropdown.innerHTML = ''
            // 修改密码
            const changePwItem = el('div', { style: { padding: '6px 12px', cursor: 'pointer', color: '#ccc' }, text: '修改密码' })
            changePwItem.addEventListener('click', () => { showChangePasswordModal(); userDropdown.style.display = 'none' })
            userDropdown.appendChild(changePwItem)
            // 退出登录
            const logoutItem = el('div', { style: { padding: '6px 12px', cursor: 'pointer', color: '#f44' }, text: '退出登录' })
            logoutItem.addEventListener('click', async () => {
              try { await bridge('POST', '/api/logout'); toast('已退出', 'ok'); refreshBackend() }
              catch (e) { toast('退出失败', 'err') }
              userDropdown.style.display = 'none'
            })
            userDropdown.appendChild(logoutItem)
            userMenuBox.style.display = ''
          } else {
            userMenuBtn.style.display = 'none'
            userMenuBox.style.display = 'none'
          }
          renderGate()
        } catch (e) { /* 后台不可达时保持默认 */ }
      }

      function renderGate() {
        const usable = fcUsable()
        gateBox.innerHTML = ''
        hideGate()
        if (state.fc && state.fc.configured === false) {
          return
        }
        if (!state.fc) return
        if (state.fc.enabled === false) {
          showGate()
          gateBox.innerHTML = `<div class="gt">服务暂不可用</div><div class="gd">管理员已停用服务,请稍后再试。</div>`
          return
        }
        if (state.fc.license_required && !state.licensed) {
          showGate()
          const row = el('div', { class: 'fls-formrow' },
            el('input', { class: 'fls-in', placeholder: '输入授权码', id: 'fls-lic-input' }),
            el('button', { class: 'fls-btn-gold', type: 'button', text: '激活' })
          )
          row.querySelector('button').addEventListener('click', async () => {
            const code = row.querySelector('#fls-lic-input').value.trim()
            if (!code) { toast('请输入授权码', 'err'); return }
            try {
              await bridge('POST', '/api/license', { code })
              setLicensed(true)
              toast('授权成功！', 'ok')
              renderGate()
            } catch (e) { toast('授权失败: ' + e.message, 'err') }
          })
          gateBox.appendChild(el('div', { class: 'gt', text: '需要授权码' }))
          gateBox.appendChild(el('div', { class: 'gd', text: '此工具需要输入有效授权码后方可使用。' }))
          gateBox.appendChild(row)
          return
        }
        if (state.fc.reg_login_required && !state.backendInfo?.loggedIn) {
          showGate()
          // 登录/注册表单
          let isLoginMode = true
          const titleEl = el('div', { class: 'gt', text: '需要登录' })
          const descEl = el('div', { class: 'gd', text: '请登录后使用。' })
          
          // 登录字段
          const loginAccount = el('input', { class: 'fls-in', placeholder: '账号(手机号/微信/邮箱/昵称)', id: 'fls-login-account' })
          const loginPw = el('input', { class: 'fls-in', placeholder: '密码', type: 'password', id: 'fls-login-pw' })
          const loginBtn = el('button', { class: 'fls-btn-gold', type: 'button', text: '登录' })
          const toRegBtn = el('button', { class: 'fls-btn-ghost2', type: 'button', text: '去注册' })
          const loginBox = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            loginAccount, loginPw,
            el('div', { style: { display: 'flex', gap: '8px' } }, loginBtn, toRegBtn)
          )
          
          // 注册字段
          const regNickname = el('input', { class: 'fls-in', placeholder: '昵称', id: 'fls-reg-nickname' })
          const regPw = el('input', { class: 'fls-in', placeholder: '密码', type: 'password', id: 'fls-reg-pw' })
          const regPhone = el('input', { class: 'fls-in', placeholder: '手机号码', id: 'fls-reg-phone' })
          const regWechat = el('input', { class: 'fls-in', placeholder: '微信号', id: 'fls-reg-wechat' })
          const regEmail = el('input', { class: 'fls-in', placeholder: '邮箱', id: 'fls-reg-email' })
          const regBtn = el('button', { class: 'fls-btn-gold', type: 'button', text: '注册' })
          const toLoginBtn = el('button', { class: 'fls-btn-ghost2', type: 'button', text: '去登录' })
          const regBox = el('div', { style: { display: 'none', flexDirection: 'column', gap: '10px' } },
            regNickname, regPw, regPhone, regWechat, regEmail,
            el('div', { style: { display: 'flex', gap: '8px' } }, regBtn, toLoginBtn)
          )
          
          const switchMode = (login) => {
            isLoginMode = login
            loginBox.style.display = login ? 'flex' : 'none'
            regBox.style.display = login ? 'none' : 'flex'
            titleEl.textContent = login ? '需要登录' : '注册新账号'
            descEl.textContent = login ? '请登录后使用。' : '请填写以下信息注册。'
          }
          
          toRegBtn.addEventListener('click', () => switchMode(false))
          toLoginBtn.addEventListener('click', () => switchMode(true))
          
          loginBtn.addEventListener('click', async () => {
            const account = loginAccount.value.trim()
            const pw = loginPw.value.trim()
            if (!account || !pw) { toast('请输入账号和密码', 'err'); return }
            try { await bridge('POST', '/api/auth', { email: account, password: pw }); toast('登录成功', 'ok'); refreshBackend() }
            catch (e) { toast('登录失败: ' + e.message, 'err') }
          })
          
          regBtn.addEventListener('click', async () => {
            const nickname = regNickname.value.trim()
            const pw = regPw.value.trim()
            const phone = regPhone.value.trim()
            const wechat = regWechat.value.trim()
            const email = regEmail.value.trim()
            if (!nickname || !pw || !phone || !wechat || !email) { toast('请填写所有字段', 'err'); return }
            try {
              await bridge('POST', '/api/register', { email, password: pw, nickname, phone, wechat })
              toast('注册并登录成功', 'ok'); refreshBackend()
            } catch (e) { toast('注册失败: ' + e.message, 'err') }
          })
          
          gateBox.appendChild(titleEl)
          gateBox.appendChild(descEl)
          gateBox.appendChild(loginBox)
          gateBox.appendChild(regBox)
          return
        }
        // 可用:隐藏门禁
        hideGate()
      }

      // ---------- 上传区 ----------
      const fileInput = el('input', { type: 'file', accept: 'image/*,.jpeg,.jpg,.png,.webp,video/*,.mp4,.mov,.webm', style: { display: 'none' } })
      const dzPrev = el('div', { class: 'fls-prev' })
      const dz = el('div', { class: 'fls-dropzone' },
        el('div', { class: 'big', text: '📁' }),
        el('div', { class: 't1', text: '拖拽文件到此处，或点击上传' }),
        el('div', { class: 't2', text: '支持 MP4, MOV, JPG, PNG, WebP' }),
        el('button', { class: 'fls-dzbtn', type: 'button', text: '选择文件' }),
        dzPrev,
        el('button', { class: 'fls-clear', type: 'button', text: '✕' })
      )
      body.appendChild(el('div', { class: 'fls-label' }, [el('b', { text: '上传要进行口型同步的视频或图片' })]))
      body.appendChild(dz)
      body.appendChild(fileInput)

      const clearFile = () => {
        if (currentObjectUrl) { try { URL.revokeObjectURL(currentObjectUrl) } catch {} ; currentObjectUrl = null }
        state.faceUrl = null; state.faceKind = null; fileInput.value = ''
        dzPrev.classList.remove('show'); dz.classList.remove('fls-hasfile')
        body.querySelectorAll('.fls-sample.selected').forEach(c => c.classList.remove('selected'))
      }
      dz.querySelector('.fls-clear').addEventListener('click', (e) => { e.stopPropagation(); clearFile() })
      dz.addEventListener('click', () => fileInput.click())
      fileInput.addEventListener('change', (e) => { const f = e.target.files[0]; if (f) onFileChosen(f) })
      ;['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.style.borderColor = '#FFD700' }))
      ;['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.style.borderColor = '' }))
      dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) onFileChosen(f) })

      let currentObjectUrl = null
      function setPreview(url, kind) {
        // 释放旧的 Object URL，防止内存泄漏
        if (currentObjectUrl) { try { URL.revokeObjectURL(currentObjectUrl) } catch {} }
        currentObjectUrl = url
        dzPrev.innerHTML = ''
        const tag = el('span', { class: 'fls-tag', text: kind === 'video' ? '🎬 视频' : '🖼️ 图片' })
        const media = kind === 'video' ? el('video', { src: url, controls: true }) : el('img', { src: url })
        dzPrev.appendChild(media); dzPrev.appendChild(tag); dzPrev.classList.add('show'); dz.classList.add('fls-hasfile')
      }
      async function onFileChosen(file) {
        if (!file) return
        const isVideo = file.type.startsWith('video') || /\.(mp4|mov|webm)$/i.test(file.name)
        const isImage = file.type.startsWith('image') || /\.(jpe?g|png|webp)$/i.test(file.name)
        if (!isVideo && !isImage) { toast('仅支持图片或视频文件', 'err'); return }
        const kind = isVideo ? 'video' : 'image'
        setPreview(URL.createObjectURL(file), kind)
        // 检测图片实际尺寸
        if (isImage) {
          try {
            const img = new Image()
            img.src = URL.createObjectURL(file)
            await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve })
            state.faceWidth = img.naturalWidth || 1024
            state.faceHeight = img.naturalHeight || 1024
            URL.revokeObjectURL(img.src)
          } catch { state.faceWidth = 1024; state.faceHeight = 1024 }
        } else {
          state.faceWidth = 1024; state.faceHeight = 1024
        }
        try {
          toast('上传中...')
          const buf = await file.arrayBuffer()
          const base64 = arrayBufferToBase64(buf)
          const d = await bridge('POST', '/api/upload', { filename: file.name, contentType: file.type, size: buf.byteLength, dataBase64: base64 })
          state.faceUrl = d.publicUrl; state.faceKind = kind
          toast('上传成功', 'ok')
          if (kind === 'image') showGenderPicker()
        } catch (e) { toast('上传失败: ' + e.message, 'err'); clearFile() }
      }

      // ---------- 性别选择弹窗（上传自定义图片后） ----------
      function showGenderPicker() {
        const existing = document.querySelector('.fls-gender-modal')
        if (existing) existing.remove()
        const modal = el('div', { class: 'fls-gender-modal show' },
          el('div', { class: 'fls-gender-panel' },
            el('div', { class: 'fls-modal-head' },
              el('span', { text: '图片中的人物性别是？' }),
              el('button', { class: 'fls-close', text: '✕', style: { width: '26px', height: '26px' } })
            ),
            el('div', { class: 'fls-gender-btns' },
              el('button', { class: 'fls-gender-btn female' },
                el('span', { text: '👩', style: { 'font-size': '28px' } }),
                el('span', { text: '女声配音' })
              ),
              el('button', { class: 'fls-gender-btn male' },
                el('span', { text: '👨', style: { 'font-size': '28px' } }),
                el('span', { text: '男声配音' })
              )
            )
          )
        )
        const pickGender = (gender) => {
          state.sampleGender = gender
          if (!state.voiceId) {
            state.defaultVoiceId = gender === 'female' ? VOICE_FEMALE_ZH : VOICE_MALE_ZH
            voiceBtn.textContent = gender === 'female' ? '🎵 默认女声' : '🎵 默认男声'
          }
          modal.remove()
          toast('已设置' + (gender === 'female' ? '女' : '男') + '声配音', 'ok')
        }
        modal.querySelector('.fls-gender-btn.female').addEventListener('click', () => pickGender('female'))
        modal.querySelector('.fls-gender-btn.male').addEventListener('click', () => pickGender('male'))
        modal.querySelector('.fls-close').addEventListener('click', () => modal.remove())
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove() })
        document.body.appendChild(modal)
      }

      // ---------- 输入方式 ----------
      body.appendChild(el('div', { class: 'fls-label' }, [el('b', { text: '输入方式' })]))
      const seg = el('div', { class: 'fls-seg' },
        el('button', { class: 'active', 'data-mode': 'text', text: '输入文本' }),
        el('button', { 'data-mode': 'audio', text: '上传音频' }),
        el('button', { 'data-mode': 'record', text: '录制音频' })
      )
      body.appendChild(seg)

      // 文本
      const textArea = el('textarea', { class: 'fls-textarea', placeholder: '输入希望人物朗读的文本，例如：大家好，欢迎收看今天的节目。' })
      const textBox = el('div', {},
        textArea,
        el('div', { class: 'fls-hint', id: 'fls-char', text: '0 字' })
      )
      body.appendChild(textBox)
      textArea.addEventListener('input', () => { state.text = textArea.value; body.querySelector('#fls-char').textContent = textArea.value.length + ' 字' })

      // 上传音频
      const audioInput = el('input', { type: 'file', class: 'fls-audiofile', accept: 'audio/*,.mp3,.wav,.m4a,.webm' })
      const audioBox = el('div', { class: 'fls-audio-box' },
        audioInput,
        el('div', { class: 'fls-hint', text: '支持 MP3, WAV, M4A, WEBM · 上限 20 秒' })
      )
      body.appendChild(audioBox)
      audioInput.addEventListener('change', async (e) => {
        const f = e.target.files[0]; if (!f) return
        if (!/\.(mp3|wav|m4a|webm)$/i.test(f.name) && !f.type.startsWith('audio')) { toast('仅支持音频文件', 'err'); return }
        toast('上传音频中...')
        try {
          const buf = await f.arrayBuffer()
          const base64 = arrayBufferToBase64(buf)
          const d = await bridge('POST', '/api/upload', { filename: f.name, contentType: f.type, size: buf.byteLength, dataBase64: base64 })
          state.audioUrl = d.publicUrl
          toast('音频已上传 (' + f.name + ')', 'ok')
        } catch (err) { toast('音频上传失败: ' + err.message, 'err') }
      })

      // 录制音频
      const recBtn = el('button', { class: 'fls-recbtn', text: '● 开始录制' })
      const recTime = el('span', { class: 'fls-rectime', text: '00:00 / 20s' })
      const recordBox = el('div', { class: 'fls-audio-box' },
        el('div', { class: 'fls-rec' }, recBtn, recTime),
        el('div', { class: 'fls-hint', text: '使用麦克风录制，上限 20 秒。录制后自动上传。' })
      )
      body.appendChild(recordBox)

      let mediaRecorder = null, recChunks = [], recStart = 0, recTimer = null
      recBtn.addEventListener('click', async () => {
        if (mediaRecorder && mediaRecorder.state === 'recording') { mediaRecorder.stop(); return }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          mediaRecorder = new MediaRecorder(stream)
          recChunks = []
          mediaRecorder.ondataavailable = e => { if (e.data.size) recChunks.push(e.data) }
          mediaRecorder.onstop = async () => {
            stream.getTracks().forEach(t => t.stop())
            clearInterval(recTimer)
            const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || 'audio/webm' })
            recBtn.textContent = '● 开始录制'; recBtn.classList.remove('recording'); recTime.textContent = '00:00 / 20s'
            toast('录制完成，上传中...')
            try {
              const base64 = arrayBufferToBase64(await blob.arrayBuffer())
              const d = await bridge('POST', '/api/upload', { filename: 'recording.webm', contentType: blob.type || 'audio/webm', size: blob.size, dataBase64: base64 })
              state.audioUrl = d.publicUrl
              toast('录音已上传', 'ok')
            } catch (err) { toast('上传失败: ' + err.message, 'err') }
          }
          mediaRecorder.start()
          recBtn.textContent = '⏹ 停止'; recBtn.classList.add('recording')
          recStart = Date.now(); recTime.textContent = '00:00 / 20s'
          recTimer = setInterval(() => {
            const s = Math.floor((Date.now() - recStart) / 1000)
            recTime.textContent = '00:' + String(s).padStart(2, '0') + ' / 20s'
            if (s >= 20 && mediaRecorder.state === 'recording') mediaRecorder.stop()
          }, 1000)
        } catch (e) { toast('无法访问麦克风: ' + e.message, 'err') }
      })

      // 模式切换
      seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach(x => x.classList.remove('active'))
        b.classList.add('active')
        const m = b.dataset.mode; state.inputMode = m
        textBox.style.display = m === 'text' ? '' : 'none'
        audioBox.classList.toggle('show', m === 'audio')
        recordBox.classList.toggle('show', m === 'record')
      }))

      // ---------- 选择模型 ----------
      body.appendChild(el('div', { class: 'fls-label' }, [el('b', { text: '选择模型' }), el('span', { text: '（仅图片输入）', style: { fontSize: '11px', color: '#666' } })]))
      const modelGrid = el('div', { class: 'fls-modelgrid' })
      const models = [
        { id: 'fast', nm: 'Fast', de: '快速生成·说话', tag: '推荐' },
        { id: 'max', nm: 'Max', de: '高清·自然表情' },
        { id: 'music', nm: 'Music', de: '适合唱歌' },
      ]
      models.forEach(md => {
        const card = el('div', { class: 'fls-modelcard' + (md.id === 'fast' ? ' active' : ''), 'data-model': md.id },
          el('div', { class: 'nm', text: md.nm }),
          el('div', { class: 'de', text: md.de })
        )
        card.addEventListener('click', () => {
          modelGrid.querySelectorAll('.fls-modelcard').forEach(x => x.classList.remove('active'))
          card.classList.add('active'); state.model = md.id
        })
        modelGrid.appendChild(card)
      })
      body.appendChild(modelGrid)

      // ---------- 生成按钮 ----------
      const genBtn = el('button', { class: 'fls-gen', text: '✦ 免费生成' })
      const voiceBtn = el('button', { class: 'fls-voice', text: '🎵 ' + state.voiceName })
      body.appendChild(el('div', { class: 'fls-genrow' }, genBtn, voiceBtn))

      // 进度
      const progStatus = el('span', { text: '准备中...' })
      const progPct = el('span', { text: '0%' })
      const progFill = el('div', { class: 'fls-pfill' })
      const progressBox = el('div', { class: 'fls-progress' },
        el('div', { class: 'fls-ptop' }, progStatus, progPct),
        el('div', { class: 'fls-pbar' }, progFill)
      )
      body.appendChild(progressBox)

      // ---------- 声音选择 ----------
      voiceBtn.addEventListener('click', async () => {
        try {
          toast('加载声音中...')
          const d = await bridge('GET', '/api/voices?locale=zh-CN')
          const voices = d.voices || []
          const zh = voices.filter(v => (v.language === 'zh-CN' || v.locale === 'zh-CN')).slice(0, 60)
          const list = zh.length ? zh : voices.slice(0, 60)
          const modal = el('div', { class: 'fls-voice-modal show' },
            el('div', { class: 'fls-voice-panel' },
              el('div', { class: 'fls-modal-head' },
                el('span', { text: '选择声音 (' + list.length + ')' }),
                el('button', { class: 'fls-close', text: '✕', style: { width: '26px', height: '26px' } })
              ),
              el('div', { class: 'fls-voice-list' })
            )
          )
          const listEl = modal.querySelector('.fls-voice-list')
          // 按性别分组：优先显示与素材匹配的性别
          const targetGender = state.sampleGender || 'female'
          const sameGender = list.filter(v => v.genderPresentation === targetGender)
          const otherGender = list.filter(v => v.genderPresentation !== targetGender)
          const sorted = [...sameGender, ...otherGender]
          const genderLabel = (g) => g === 'female' ? '女声' : g === 'male' ? '男声' : '其他'
          let lastGender = null
          sorted.forEach(v => {
            const g = v.genderPresentation || 'unknown'
            if (g !== lastGender) {
              const hdr = el('div', { class: 'fls-voice-hdr', text: (g === targetGender ? '▶ ' : '') + genderLabel(g) + (g === targetGender && state.sampleGender ? '（推荐）' : '') })
              listEl.appendChild(hdr)
              lastGender = g
            }
            const item = el('div', { class: 'fls-voice-item' },
              el('div', { text: v.name || '?' }),
              el('div', { class: 'vl', text: (v.language || '') + (v.description ? ' · ' + v.description.slice(0, 30) : '') })
            )
            item.addEventListener('click', () => {
              state.voiceId = v.id; state.voiceName = v.name || '默认'
              state.sampleGender = v.genderPresentation || state.sampleGender
              voiceBtn.textContent = '🎵 ' + state.voiceName
              modal.remove(); toast('已选择声音: ' + state.voiceName, 'ok')
            })
            listEl.appendChild(item)
          })
          modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove() })
          modal.querySelector('.fls-close').addEventListener('click', () => modal.remove())
          document.body.appendChild(modal)
        } catch (e) { toast('加载声音失败', 'err') }
      })

      // ---------- 生成 ----------
      genBtn.addEventListener('click', () => {
        refreshBackend()
        if (!state.faceUrl) { toast('请先上传或选择一个图片/视频', 'err'); return }
        let mode
        if (state.inputMode === 'text') {
          if (!state.text.trim()) { toast('请输入文本', 'err'); return }
          mode = 'text'
        } else {
          if (!state.audioUrl) { toast('请先上传或录制音频', 'err'); return }
          mode = 'audio'
        }
        const payload = {
          inputType: 'image', mode, workType: 'single_speaker',
          faceUrl: state.faceUrl, sourceWidth: state.faceWidth, sourceHeight: state.faceHeight,
          requestedTier: 'free', generationModel: state.model,
          surface: 'dsh-ui', locale: 'zh-CN', sessionId: 'dshui-' + Math.random().toString(36).slice(2) + Date.now(),
        }
        if (mode === 'text') {
          payload.text = state.text
          payload.presetVoiceId = state.voiceId || state.defaultVoiceId
        }
        else payload.audioUrl = state.audioUrl
        submitGenerate(payload)
      })

      async function submitGenerate(payload) {
        genBtn.disabled = true
        progressBox.classList.add('show'); progStatus.textContent = '提交中...'; progFill.style.width = '0%'
        try {
          const d = await bridge('POST', '/api/generate', payload)
          if (!d.generationId) throw new Error('无 generationId')
          state.currentGen = d.generationId
          await bridge('POST', '/api/history', { generationId: d.generationId, status: 'processing', text: payload.text || '音频', model: state.model, createdAt: Date.now() }).catch(() => {})
          pollStatus(d.generationId)
        } catch (e) {
          genBtn.disabled = false; progressBox.classList.remove('show')
          toast('生成失败: ' + e.message, 'err')
        }
      }

      async function pollStatus(genId, retries) {
        retries = retries || 0
        const MAX_RETRIES = 60 // 最多轮询 5 分钟 (60 * 5s)
        try {
          const d = await bridge('POST', '/api/status', { generationId: genId })
          if (d.status === 'completed') {
            progStatus.textContent = '✅ 生成完成！'; progFill.style.width = '100%'; progPct.textContent = '100%'
            genBtn.disabled = false
            toast('生成完成！', 'ok')
          const playUrl = d.lowResolutionVideoUrl || d.videoUrl
          await bridge('POST', '/api/history', { generationId: genId, status: 'completed', videoUrl: d.videoUrl, lowResolutionVideoUrl: d.lowResolutionVideoUrl, text: state.text || '音频', model: state.model, createdAt: Date.now() }).catch(() => {})
          toast('生成完成,可点击「下载」获取无水印视频', 'ok')
            setTimeout(() => progressBox.classList.remove('show'), 4000)
            loadHistory()
            return
          }
          if (d.status === 'failed') {
            progStatus.textContent = '❌ 生成失败: ' + (d.error || '未知'); genBtn.disabled = false
            toast('生成失败', 'err'); return
          }
          const pct = d.progress ?? d.generationProgress?.estimatedProgress ?? 0
          progStatus.textContent = d.status === 'generating_video' ? '🎬 合成视频中...' : (d.status === 'processing' ? '⏳ 处理中...' : '⏳ ' + (d.status || '处理中') + '...')
          progFill.style.width = pct + '%'; progPct.textContent = pct + '%'
          if (state.timer) clearTimeout(state.timer)
          state.timer = setTimeout(() => pollStatus(genId, retries + 1), 5000)
        } catch (e) {
          progStatus.textContent = '轮询出错，重试中...'
          if (retries >= MAX_RETRIES) { progStatus.textContent = '❌ 轮询超时'; genBtn.disabled = false; return }
          if (state.timer) clearTimeout(state.timer)
          state.timer = setTimeout(() => pollStatus(genId, retries + 1), 5000)
        }
      }

      // ---------- 示例素材 ----------
      const samplesWrap = el('div', { class: 'fls-samples' })
      body.appendChild(el('div', { class: 'fls-subtitle', text: '示例素材' }))
      body.appendChild(samplesWrap)

      async function loadSamples() {
        try {
          const d = await bridge('GET', '/api/samples')
          const samples = d.samples || []
          samplesWrap.innerHTML = ''
          if (!samples.length) { samplesWrap.innerHTML = '<div class="fls-empty">暂无示例</div>'; return }
          samples.slice(0, 18).forEach(s => {
            // 确保 mediaUrl 为完整 URL
            let imgUrl = s.mediaUrl || s.thumbnailUrl || ''
            if (imgUrl && !/^https?:\/\//i.test(imgUrl)) imgUrl = 'https://freelipsync.com' + (imgUrl.startsWith('/') ? '' : '/') + imgUrl
            const isVideo = s.mediaType === 'video' || /\.(mp4|webm|mov)$/i.test(imgUrl)
            const mediaEl = isVideo
              ? el('video', { src: imgUrl, muted: true, loop: true, preload: 'metadata', onmouseenter: function() { this.play() }, onmouseleave: function() { this.pause(); this.currentTime = 0 } })
              : el('img', { src: imgUrl, loading: 'lazy', onerror: function() { this.style.display = 'none' } })
            const card = el('div', { class: 'fls-sample' },
              mediaEl,
              el('div', { class: 'sn', text: s.title || '示例' })
            )
            card.addEventListener('click', () => {
              clearFile()
              document.body.querySelectorAll('.fls-sample.selected').forEach(c => c.classList.remove('selected'))
              card.classList.add('selected')
              state.faceUrl = imgUrl; state.faceKind = s.mediaType === 'video' ? 'video' : 'image'
              setPreview(imgUrl, state.faceKind)
              // 检测示例图片尺寸
              if (!isVideo) {
                const tmpImg = new Image()
                tmpImg.crossOrigin = 'anonymous'
                tmpImg.src = imgUrl
                tmpImg.onload = () => { state.faceWidth = tmpImg.naturalWidth || 1024; state.faceHeight = tmpImg.naturalHeight || 1024 }
                tmpImg.onerror = () => { state.faceWidth = 1024; state.faceHeight = 1024 }
              } else {
                state.faceWidth = 1024; state.faceHeight = 1024
              }
              // 根据素材性别自动切换默认声音（用户未手动选声音时）
              const gender = s.genderPresentation || null
              state.sampleGender = gender
              if (!state.voiceId) {
                if (gender === 'female') { state.defaultVoiceId = VOICE_FEMALE_ZH; voiceBtn.textContent = '🎵 默认女声' }
                else if (gender === 'male') { state.defaultVoiceId = VOICE_MALE_ZH; voiceBtn.textContent = '🎵 默认男声' }
              }
              toast('已选择示例素材' + (gender ? '（' + (gender === 'female' ? '女' : '男') + '性）' : ''), 'ok')
            })
            samplesWrap.appendChild(card)
          })
        } catch (e) { samplesWrap.innerHTML = '<div class="fls-empty">示例加载失败</div>' }
      }

      // ---------- 历史 ----------
      const histWrap = el('div', { class: 'fls-hist' })
      const histPager = el('div', { class: 'fls-pager' })
      body.appendChild(el('div', { class: 'fls-subtitle', text: '最近生成' }))
      body.appendChild(histWrap)
      body.appendChild(histPager)

      let histData = [], histPage = 1, histPerPage = 8

      async function loadHistory() {
        try {
          histData = await bridge('GET', '/api/history')
          histPage = 1
          renderHistoryPage()
        } catch (e) { histWrap.innerHTML = '<div class="fls-empty">历史加载失败</div>' }
      }

      function renderHistoryPage() {
        histWrap.innerHTML = ''
        histPager.innerHTML = ''
        if (!histData.length) { histWrap.innerHTML = '<div class="fls-empty" style="grid-column:1/-1">你还没有视频。现在开始，免费又简单。</div>'; return }
        const totalPages = Math.ceil(histData.length / histPerPage)
        if (histPage > totalPages) histPage = totalPages
        const start = (histPage - 1) * histPerPage
        const pageItems = histData.slice(start, start + histPerPage)

        pageItems.forEach(h => {
          const card = el('div', { class: 'fls-histcard' })
          const playUrl = h.lowResolutionVideoUrl || h.videoUrl
          let media
          if (playUrl) media = el('video', { src: playUrl, controls: true, preload: 'metadata' })
          else media = el('div', { style: { width: '100%', height: '90px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontSize: '11px', background: '#121212' }, text: h.status === 'processing' ? '⏳ 生成中...' : '🎬' })
          card.appendChild(media)
          // 删除按钮
          const delBtn = el('button', { class: 'fls-del', text: '✕', title: '删除' })
          delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteHistory(h.generationId) })
          card.appendChild(delBtn)
          const b = el('div', { class: 'fls-histbody' })
          b.appendChild(el('div', { class: 'fls-histtext', text: h.text || '音频' }))
          b.appendChild(el('div', { class: 'fls-histstatus ' + (h.status === 'completed' ? 'ok' : h.status === 'failed' ? 'err' : 'wait'), text: h.status === 'completed' ? '✅ 已完成' : h.status === 'failed' ? '❌ 失败' : '⏳ 生成中' }))
          if (h.status === 'completed' && playUrl) {
            const dl = el('button', { class: 'fls-dl', text: '⬇ 下载' })
            dl.addEventListener('click', (e) => { e.stopPropagation(); downloadVideo(h.generationId, fileName(h)) })
            b.appendChild(dl)
          }
          card.appendChild(b)
          histWrap.appendChild(card)
        })

        // 分页控件
        if (totalPages > 1) {
          const prevBtn = el('button', { text: '← 上一页' })
          if (histPage <= 1) prevBtn.disabled = true
          prevBtn.addEventListener('click', () => { if (!prevBtn.disabled) { histPage--; renderHistoryPage() } })
          const info = el('span', { text: histPage + ' / ' + totalPages })
          const nextBtn = el('button', { text: '下一页 →' })
          if (histPage >= totalPages) nextBtn.disabled = true
          nextBtn.addEventListener('click', () => { if (!nextBtn.disabled) { histPage++; renderHistoryPage() } })
          histPager.appendChild(prevBtn)
          histPager.appendChild(info)
          histPager.appendChild(nextBtn)
        }
      }

      async function deleteHistory(genId) {
        if (!confirm('确定要删除这条记录吗？')) return
        try {
          await bridge('POST', '/api/history/delete', { generationId: genId })
          histData = histData.filter(h => h.generationId !== genId)
          renderHistoryPage()
          toast('已删除', 'ok')
        } catch (e) { toast('删除失败: ' + e.message, 'err') }
      }

      // ---------- 下载 ----------
      function fileName(h) {
        const base = (h.text || 'lipsync').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'lipsync'
        return base + '-' + String(h.generationId).slice(0, 8) + '.mp4'
      }
      async function downloadVideo(genId, name) {
        try {
          toast('正在申请无水印下载(须在授权配额内)...')
          const d = await bridge('POST', '/api/download', { generationId: genId })
          if (!d.url) throw new Error('未返回下载链接')
          const a = document.createElement('a')
          a.href = BRIDGE + d.url
          a.download = name
          document.body.appendChild(a); a.click(); a.remove()
          toast('已开始下载: ' + name, 'ok')
        } catch (e) { toast('下载失败: ' + e.message, 'err') }
      }

      // ---------- Toast ----------
      let toastEl = null, toastTimer = null
      function toast(msg, type) {
        if (!toastEl) {
          toastEl = el('div', { class: 'fls-toast' })
          document.body.appendChild(toastEl)
        }
        toastEl.textContent = msg
        toastEl.className = 'fls-toast show ' + (type || '')
        clearTimeout(toastTimer)
        toastTimer = setTimeout(() => toastEl.className = 'fls-toast', 3000)
      }

      // ---------- 挂载到 document.body ----------
      root.appendChild(fab)
      root.appendChild(drawer)
      root.appendChild(fileInput)

      // 返回清理函数
      return () => {
        if (state.timer) clearTimeout(state.timer)
        if (recTimer) clearInterval(recTimer)
        fab.remove(); drawer.remove(); fileInput.remove()
        if (toastEl) toastEl.remove()
      }
    }

    // ============================================================
    // apply(ctx)
    // ============================================================
    function apply(ctx) {
      // 注入 CSS
      const styleId = 'dsh-tool-lipsync-css'
      if (!document.getElementById(styleId)) {
        const s = document.createElement('style')
        s.id = styleId
        s.textContent = CSS
        document.head.appendChild(s)
      }
      let detach = buildUI(document.body)
      // 注册清理
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(() => () => { try { detach() } catch {} })
      }
      return ctx
    }

    const __exports__ = { name: name, inject: inject, apply: apply }
    if (module) { module.exports = __exports__ }
    return __exports__
  },
})
