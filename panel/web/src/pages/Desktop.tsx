import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useUI } from '../ui';
import { useAuth } from '../auth';
import { useInstances } from '../AppShell';

// KasmVNC noVNC 页面；反代按实例隔离：/desktop/<id>/* → 对应容器，注入凭据。
function desktopUrl(id: string) {
  return (
    `/desktop/${id}/vnc/index.html?autoconnect=1&path=desktop/${id}/websockify&resize=remote` +
    '&reconnect=true&reconnect_delay=2000&clipboard_up=true&clipboard_down=true&clipboard_seamless=true'
  );
}

interface TFile {
  name: string;
  size: number;
}
function humanSize(n: number) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

const MenuIcon = (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4 6h16M4 12h16M4 18h16" />
  </svg>
);

export default function InstanceView({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { user } = useAuth();
  const { toast, confirm } = useUI();
  const { instances, loaded, reload } = useInstances();
  const isAdmin = user?.role === 'admin';

  const [frameLoaded, setFrameLoaded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [files, setFiles] = useState<TFile[]>([]);
  const [showClip, setShowClip] = useState(false);
  const [clipText, setClipText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [control, setControl] = useState<{ free: boolean; mine: boolean; holder: string | null } | null>(null);
  const [vncNonce, setVncNonce] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const dragDepth = useRef(0);
  const lastBeat = useRef(0);
  const lastImeError = useRef(0);

  const inst = instances.find((i) => i.id === id);
  // 进入实例时，共享列表可能尚未同步（管理页新建/安装后），先按"探测中"显示加载态，
  // 等列表刷新到该实例或超时后再判定是否真的不存在，避免从管理页跳转时误报"实例不存在"。
  const [probing, setProbing] = useState(true);
  const offline = inst ? inst.runtime !== 'running' : false;
  const installed = !!inst && inst.wechat.installed && inst.wechat.phase !== 'downloading';
  const showVnc = !!inst && !offline && installed;

  // 切换实例时重置内嵌态
  useEffect(() => {
    setFrameLoaded(false);
    setShowFiles(false);
    setFiles([]);
    setShowClip(false);
    setClipText('');
    setProbing(true);
  }, [id]);

  // 探测态收敛：找到实例即结束；否则给共享列表一点刷新时间（AppShell 已在导航时拉取），超时仍无则判定不存在。
  useEffect(() => {
    if (inst) {
      setProbing(false);
      return;
    }
    if (!probing) return;
    const t = window.setTimeout(() => setProbing(false), 2500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst, probing, id]);

  // 实例未就绪（启动中 / 安装中 / 上下文状态未刷新）时，每 3s 拉取最新状态：
  // 就绪后自动进入桌面，无需手动刷新（修复"安装完进度 100% 仍提示无实例"）。
  useEffect(() => {
    if (showVnc || !id) return;
    const t = window.setInterval(() => {
      if (!document.hidden) reload();
    }, 3000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showVnc, id]);

  // 文件拖到窗口 → 弹出落区（覆盖 iframe 接住 drop）
  useEffect(() => {
    if (!showVnc) return;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDropWin = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDropWin);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDropWin);
    };
  }, [showVnc]);

  // 控制权（交互驱动的心跳软锁）：每 3s 只读轮询当前操作者；超 TTL 自动释放。
  useEffect(() => {
    if (!showVnc || !id) {
      setControl(null);
      return;
    }
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const r = await api.controlStatus(id);
        if (!alive) return;
        setControl(r);
        if (!r.free && !r.mine) frameRef.current?.blur(); // 只读：移开键盘焦点
      } catch {
        /* ignore */
      }
    };
    poll();
    const t = window.setInterval(poll, 3000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [showVnc, id]);

  // 用户在 VNC 内真实操作（鼠标/键盘/滚轮）时续约控制权（同源 iframe 可监听）。节流 2.5s。
  // 只读用户的操作已被遮罩拦截/失焦，不会误续约；空闲不操作则超时自动释放。
  useEffect(() => {
    if (!showVnc || !id || !frameLoaded) return;
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    const onInteract = async () => {
      const now = Date.now();
      if (now - lastBeat.current < 2500) return;
      lastBeat.current = now;
      try {
        const r = await api.controlBeat(id);
        setControl({ free: false, mine: r.mine, holder: r.holder });
      } catch {
        /* ignore */
      }
    };
    const evs = ['mousedown', 'keydown', 'wheel'] as const;
    try {
      evs.forEach((e) => win.addEventListener(e, onInteract, { capture: true, passive: true }));
    } catch {
      return;
    }
    return () => {
      try {
        evs.forEach((e) => win.removeEventListener(e, onInteract, { capture: true } as any));
      } catch {
        /* ignore */
      }
    };
  }, [showVnc, id, frameLoaded]);

  if (!id) {
    nav('/', { replace: true });
    return null;
  }

  const refreshFiles = async () => {
    try {
      const { files } = await api.listFiles(id);
      setFiles(files);
    } catch {
      /* ignore */
    }
  };

  const uploadFiles = async (list: FileList | File[]) => {
    const arr = Array.from(list);
    if (!arr.length) return;
    setUploading(true);
    let ok = 0;
    for (const f of arr) {
      try {
        await api.uploadFile(id, f);
        ok++;
      } catch (e: any) {
        toast(`${f.name}: ${e.message || '上传失败'}`, 'error');
      }
    }
    setUploading(false);
    if (ok) {
      toast(`已上传 ${ok} 个文件到桌面，微信里可直接选取`, 'ok');
      refreshFiles();
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    dragDepth.current = 0;
    if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files);
  };

  const delFile = async (name: string) => {
    if (!(await confirm({ title: `删除「${name}」？`, body: '将从微信桌面（~/Desktop）移除该文件。', danger: true, confirmText: '删除' }))) return;
    try {
      await api.deleteFile(id, name);
      toast('已删除', 'ok');
      refreshFiles();
    } catch (e: any) {
      toast(e.message || '删除失败', 'error');
    }
  };

  // 同源 iframe：把键盘焦点交给 VNC，帮助宿主机输入法把合成的字送进去
  const focusFrame = () => {
    try {
      frameRef.current?.focus();
      frameRef.current?.contentWindow?.focus();
      const ki = frameRef.current?.contentDocument?.getElementById('noVNC_keyboardinput') as HTMLElement | null;
      ki?.focus();
    } catch {
      /* 跨域兜底（正常同源不会到这） */
    }
  };

  // 桌面加载后给 noVNC 原生控制条注入"实心可见"样式：原生背景近纯黑半透明，叠在深色/黑屏上看不见。
  // 注入后，用 KasmVNC 自带的左侧边缘手柄拉出控制条（音频/剪贴板/键盘/全屏等）时即可见。iframe 同源可直接访问。
  const injectVncStyle = () => {
    try {
      const doc = frameRef.current?.contentDocument;
      if (!doc || doc.getElementById('woc-vnc-style')) return;
      const st = doc.createElement('style');
      st.id = 'woc-vnc-style';
      st.textContent =
        '#noVNC_control_bar_anchor{z-index:2147483647!important;}' +
        '#noVNC_control_bar{background:rgba(18,22,30,.96)!important;border:1px solid rgba(255,255,255,.55)!important;box-shadow:0 0 24px rgba(0,0,0,.55)!important;}' +
        '#noVNC_control_bar_handle{opacity:1!important;background:rgba(18,22,30,.96)!important;border:1px solid rgba(255,255,255,.5)!important;}' +
        // macOS 中文输入法需要目标元素有非零尺寸才能激活；KasmVNC 默认 0x0 导致无法切换输入法
        '#noVNC_keyboardinput{width:1px!important;height:1px!important;opacity:0!important;overflow:hidden!important;}';
      (doc.head || doc.documentElement).appendChild(st);
    } catch {
      /* 同源正常不会到这 */
    }
  };

  // 中文 IME 输入修复：绕过 VNC XKB keysym 容量限制（~21 个 CJK 字符后 keymap 满，输入全废）。
  // 根因：KasmVNC 的 Perl 补丁在 compositionend 发 CJK keysym，但紧随其后的 _handleInput
  // diff 逻辑会发 Backspace 清拼音，把刚发的字也删了。必须在捕获阶段拦截，阻止 Perl 补丁执行，
  // 手动重置内部状态（防止 _handleInput 发 Backspace），然后通过 API 用 xdotool 粘贴文字。
  const patchVncIme = () => {
    try {
      const doc = frameRef.current?.contentDocument;
      if (!doc || doc.getElementById('woc-ime-patch')) return;
      const ta = doc.getElementById('noVNC_keyboardinput') as HTMLTextAreaElement | null;
      if (!ta) return;
      const win = frameRef.current?.contentWindow as any;
      let imeComposing = false;
      let swallowInputUntil = 0;
      const keyboard = () => {
        const cv = doc.querySelector('canvas') as any;
        return win?.UI?.rfb?.keyboard || cv?._rfb?.keyboard || null;
      };
      const installKeyboardGuard = () => {
        const kb = keyboard() as any;
        if (!kb || kb._wocImeGuard || typeof kb._sendKeyEvent !== 'function') return;
        const original = kb._sendKeyEvent.bind(kb);
        kb._wocImeGuard = true;
        if (typeof kb._wocImeSuppressUnicode !== 'boolean') kb._wocImeSuppressUnicode = false;
        kb._sendKeyEvent = (keysym: number, ...args: any[]) => {
          if (kb._wocImeSuppressUnicode && typeof keysym === 'number' && keysym >= 0x01000000) return;
          return original(keysym, ...args);
        };
      };
      const syncKeyboardInput = (value: string) => {
        try {
          installKeyboardGuard();
          const kb = keyboard();
          if (kb) {
            kb._imeInProgress = false;
            kb._imeHold = false;
            kb._lastKeyboardInput = value;
            if (kb._rfbKeyQueue) kb._rfbKeyQueue.length = 0;
          }
        } catch { /* ignore */ }
      };
      const swallowNoVncInput = (e: Event) => {
        if (!imeComposing && Date.now() > swallowInputUntil) return;
        e.stopImmediatePropagation();
        syncKeyboardInput((e.target as HTMLTextAreaElement).value);
      };
      ta.addEventListener('compositionstart', (e) => {
        imeComposing = true;
        const kb = keyboard() as any;
        if (kb) kb._wocImeSuppressUnicode = true;
        e.stopImmediatePropagation();
        syncKeyboardInput((e.target as HTMLTextAreaElement).value);
      }, true);
      ta.addEventListener('beforeinput', swallowNoVncInput, true);
      ta.addEventListener('input', swallowNoVncInput, true);
      ta.addEventListener('compositionend', (e) => {
        const text = (e as CompositionEvent).data;
        if (!text || !id) return;
        imeComposing = false;
        swallowInputUntil = Date.now() + 300;
        e.stopImmediatePropagation(); // 阻止 KasmVNC 原生 IME 路径再发一遍 keysym
        const kb = keyboard() as any;
        if (kb) kb._wocImeSuppressUnicode = true;
        syncKeyboardInput((e.target as HTMLTextAreaElement).value);
        window.setTimeout(() => {
          ta.value = '';
          syncKeyboardInput('');
          const kb = keyboard() as any;
          if (kb) kb._wocImeSuppressUnicode = false;
        }, 0);
        // 通过面板 API → xdotool 在容器内粘贴，完全绕过 VNC keysym
        api.typeInInstance(id, text).catch((err) => {
          const now = Date.now();
          if (now - lastImeError.current > 3000) {
            lastImeError.current = now;
            toast(err?.message || '中文输入失败，请确认实例镜像包含 xclip/xdotool', 'error');
          }
        });
      }, true); // capture：先于 Perl 补丁的 bubble handler
      const mark = doc.createElement('meta');
      mark.id = 'woc-ime-patch';
      (doc.head || doc.documentElement).appendChild(mark);
    } catch {
      /* ignore */
    }
  };

  // 跨设备剪贴板（文本）：通过同源 iframe 直接喂给 KasmVNC 自带的剪贴板 textarea 并触发其发送逻辑
  // （内部走 RFB.clipboardPasteFrom → clientCutText）。不依赖浏览器异步剪贴板 API，故 http/局域网 IP 下也可用，
  // 规避了"非安全上下文禁用 navigator.clipboard 导致粘贴失败"的问题。文本会进入容器系统剪贴板，
  // 在微信输入框按 Ctrl+V 即可粘贴。
  const pushClipboardToRemote = (text: string): boolean => {
    try {
      const doc = frameRef.current?.contentDocument;
      const ta = doc?.getElementById('noVNC_clipboard_text') as HTMLTextAreaElement | null;
      if (!doc || !ta) return false;
      ta.value = text;
      ta.dispatchEvent(new (frameRef.current!.contentWindow as any).Event('change', { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  };

  const sendClip = () => {
    const t = clipText;
    if (!t) {
      toast('请先输入要发送的文本', 'error');
      return;
    }
    if (pushClipboardToRemote(t)) {
      toast('已发送到容器剪贴板，请在微信输入框按 Ctrl+V 粘贴', 'ok');
    } else {
      toast('发送失败：桌面尚未连接', 'error');
    }
  };

  // 读取容器（微信侧）当前剪贴板内容到本框，便于把容器内复制的文字带回本地
  const pullClipboardFromRemote = () => {
    try {
      const doc = frameRef.current?.contentDocument;
      const ta = doc?.getElementById('noVNC_clipboard_text') as HTMLTextAreaElement | null;
      if (ta) {
        setClipText(ta.value || '');
        toast('已读取容器剪贴板', 'ok');
      } else {
        toast('读取失败：桌面尚未连接', 'error');
      }
    } catch {
      toast('读取失败', 'error');
    }
  };

  const restartInstance = async () => {
    const ok = await confirm({
      title: '重启该实例？',
      body: '会重建容器（聊天记录保留），微信重新启动，约十几秒；用于修复卡死/最小化丢失等。',
      confirmText: '重启',
    });
    if (!ok) return;
    try {
      await api.instanceRestart(id);
      toast('已重启，正在重连…', 'ok');
      setFrameLoaded(false);
      setVncNonce((n) => n + 1); // 强制 iframe 重挂、重连
      await reload();
    } catch (e: any) {
      toast(e.message || '重启失败', 'error');
    }
  };

  const takeControl = async () => {
    try {
      const r = await api.controlTake(id);
      setControl({ free: false, mine: r.mine, holder: r.holder });
      lastBeat.current = Date.now();
      focusFrame();
    } catch (e: any) {
      toast(e.message || '接管失败', 'error');
    }
  };

  const start = async () => {
    setStarting(true);
    try {
      await api.instanceStart(id);
      toast('实例已启动', 'ok');
      await reload();
    } catch (e: any) {
      toast(e.message || '启动失败', 'error');
    } finally {
      setStarting(false);
    }
  };

  const title = inst?.name || '微信实例';

  return (
    <div className="ws-page">
      <header className="ws-head">
        <button className="ws-menu" onClick={onOpenMenu} aria-label="菜单">
          {MenuIcon}
        </button>
        <span className="ws-title">{title}</span>
        {showVnc && (
          <>
            <button
              className="ws-action"
              title="文件传输"
              onClick={() => {
                setShowFiles((v) => !v);
                if (!showFiles) refreshFiles();
              }}
            >
              文件
            </button>
            <button
              className="ws-action"
              title="把文本发送到容器剪贴板（局域网 http 下也可用）"
              onClick={() => setShowClip((v) => !v)}
            >
              剪贴板
            </button>
            {isAdmin && (
              <button className="ws-action" title="重启实例（修复卡死/最小化丢失）" onClick={restartInstance}>
                重启
              </button>
            )}
          </>
        )}
      </header>

      {/* —— 各种态 —— */}
      {!loaded || (probing && !inst) ? (
        <div className="iv-stage iv-center">
          <div className="spinner" />
        </div>
      ) : !inst ? (
        <div className="iv-stage iv-center">
          <div className="iv-notice">
            <div className="iv-notice-title">无权访问或实例不存在</div>
            <button className="btn btn-primary iv-notice-btn" onClick={() => nav('/')}>
              返回主页
            </button>
          </div>
        </div>
      ) : offline ? (
        <div className="iv-stage iv-center">
          <div className="iv-notice">
            <div className="iv-notice-title">{inst.runtime === 'missing' ? '容器尚未创建' : '实例已停止'}</div>
            {isAdmin ? (
              <button className="btn btn-primary iv-notice-btn" disabled={starting} onClick={start}>
                {starting ? '启动中…' : inst.runtime === 'missing' ? '创建并启动' : '启动实例'}
              </button>
            ) : (
              <div className="iv-notice-sub">请联系管理员启动该实例</div>
            )}
            {isAdmin && (
              <button className="btn-text" onClick={() => window.open(api.instanceLogsUrl(id), '_blank')}>
                查看日志
              </button>
            )}
          </div>
        </div>
      ) : ['downloading', 'extracting', 'installing'].includes(inst.wechat.phase) ? (
        <div className="iv-stage iv-center">
          <div className="iv-notice">
            <div className="spinner" />
            <div className="iv-notice-title">微信安装中…</div>
            <div className="iv-notice-sub">
              {inst.wechat.message || '请稍候'}
              {inst.wechat.percent >= 0 ? ` · ${inst.wechat.percent}%` : ''} ——完成后自动进入，无需刷新
            </div>
          </div>
        </div>
      ) : !installed ? (
        <div className="iv-stage iv-center">
          <div className="iv-notice">
            <div className="iv-notice-title">{inst.wechat.phase === 'error' ? '微信安装出错' : '微信尚未安装'}</div>
            <div className="iv-notice-sub">
              {inst.wechat.phase === 'error'
                ? inst.wechat.message || '安装失败，可在「管理」重试'
                : '该实例容器已就绪，但尚未安装微信'}
            </div>
            {isAdmin ? (
              <button className="btn btn-primary iv-notice-btn" onClick={() => nav('/admin')}>
                去「管理」{inst.wechat.phase === 'error' ? '重试 / 更新' : '下载安装'}
              </button>
            ) : (
              <div className="iv-notice-sub">请联系管理员在「管理」中下载安装微信</div>
            )}
            {isAdmin && (
              <button className="btn-text" onClick={() => window.open(api.instanceLogsUrl(id), '_blank')}>
                查看日志
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="iv-stage">
          <iframe
            key={`${id}:${vncNonce}`}
            ref={frameRef}
            className="iv-frame"
            src={desktopUrl(id)}
            title="电脑版微信"
            allow="clipboard-read; clipboard-write; microphone; camera; autoplay"
            onLoad={() => {
              setFrameLoaded(true);
              setTimeout(() => {
                focusFrame(); // 加载完把键盘焦点交给 VNC（宿主机输入法）
                injectVncStyle(); // 让原生控制条在深色背景下可见
                patchVncIme(); // 修复中文 IME 吞字（绕过 VNC XKB keysym 限制）
              }, 500);
            }}
          />

          {!frameLoaded && (
            <div className="iv-loading">
              <div className="spinner" />
              <div className="iv-loading-text">正在连接桌面…</div>
              <div className="iv-loading-sub">首次进入请扫码登录微信</div>
              <div className="iv-loading-sub">拖文件到此处即可上传；音频/剪贴板等在画面左侧边缘的工具条里</div>
              {!window.isSecureContext && (
                <div className="iv-loading-warn">当前非 HTTPS 访问，浏览器将禁用麦克风与摄像头（音频播放不受影响）</div>
              )}
            </div>
          )}

          {dragging && (
            <div className="iv-drop" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
              <div className="drop-card">
                <div className="drop-icon">⬇</div>
                <div className="drop-title">松开上传到微信桌面</div>
                <div className="drop-sub">上传后在微信里「+ / 文件」选择即可</div>
              </div>
            </div>
          )}

          {control && !control.free && !control.mine && (
            <div className="iv-lock">
              <div className="iv-lock-card">
                <div className="iv-lock-title">「{control.holder}」正在操作</div>
                <div className="iv-lock-sub">为避免多端互相干扰，你当前为只读模式。</div>
                <button className="btn btn-primary iv-notice-btn" onClick={takeControl}>
                  申请控制
                </button>
              </div>
            </div>
          )}

          {showFiles && (
            <div className="iv-files">
              <div className="files-head">
                <span>文件传输</span>
                <button className="btn-text" onClick={() => setShowFiles(false)}>
                  关闭
                </button>
              </div>
              <input
                ref={fileInput}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files) uploadFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <button className="btn btn-primary files-upload" disabled={uploading} onClick={() => fileInput.current?.click()}>
                {uploading ? '上传中…' : '＋ 选择文件上传'}
              </button>
              <div className="files-hint">也可直接把文件拖进来。下方为桌面（~/Desktop）里的文件，微信收到的文件另存到桌面即可在此下载。</div>
              <div className="files-list">
                {files.length === 0 && (
                  <div className="muted small" style={{ padding: '10px 2px' }}>
                    暂无文件
                  </div>
                )}
                {files.map((f) => (
                  <div key={f.name} className="files-item">
                    <a className="files-dl" href={api.downloadFileUrl(id, f.name)} download={f.name} title="下载">
                      <span className="files-name">{f.name}</span>
                      <span className="files-size">{humanSize(f.size)} ↓</span>
                    </a>
                    <button className="files-del" title="删除" onClick={() => delFile(f.name)}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {showClip && (
            <div className="iv-files">
              <div className="files-head">
                <span>文本剪贴板</span>
                <button className="btn-text" onClick={() => setShowClip(false)}>
                  关闭
                </button>
              </div>
              <textarea
                className="clip-area"
                value={clipText}
                onChange={(e) => setClipText(e.target.value)}
                placeholder="在此输入或粘贴文本，点「发送到微信」后到微信输入框按 Ctrl+V 粘贴"
                rows={5}
              />
              <button className="btn btn-primary files-upload" onClick={sendClip}>
                发送到微信（容器剪贴板）
              </button>
              <button className="btn-text" style={{ alignSelf: 'flex-start', marginTop: 6 }} onClick={pullClipboardFromRemote}>
                ↓ 读取容器剪贴板到此框
              </button>
              <div className="files-hint">
                局域网 http 访问时浏览器会禁用系统级剪贴板同步，故用此框中转：文本→容器剪贴板，再在微信里 Ctrl+V。
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
