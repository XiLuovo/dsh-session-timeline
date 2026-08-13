window.__ModuleLoader__.load({
	id: "dsh-session-timeline",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		// ---- 纯 JS 辅助函数 ----
		function previewOf(content) {
			if (!Array.isArray(content)) return '';
			let text = '';
			for (const block of content) {
				if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
					text += ' ' + block.text;
				}
			}
			text = text.replace(/\s+/g, ' ').trim();
			if (!text) return '（非文本消息）';
			return text;
		}

		function fmtTime(value) {
			if (typeof value !== 'number') return '';
			try {
				return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
			} catch (error) {
				return '';
			}
		}

		// ---- 订阅当前会话的 ConversationSnapshot ----
		function useSessionSnapshot(sessions, sessionId) {
			const [snap, setSnap] = React.useState(null);
			React.useEffect(() => {
				if (!sessionId) {
					setSnap(null);
					return;
				}
				let face = null;
				try {
					const binding = sessions.binding(sessionId);
					face = binding ? binding.session : null;
				} catch (error) {
					face = null;
				}
				if (!face) {
					setSnap(null);
					return;
				}
				setSnap(face.getSnapshot());
				return face.subscribe(() => setSnap(face.getSnapshot()));
			}, [sessions, sessionId]);
			return snap;
		}

		// ---- 主组件：横短横线时间轴（全量条数 + 内部滚动 + 窗口内交互） ----
		function TimelineStrip({ sessions, useSessions }) {
			const sessionId = useSessions((s) => s.current);
			const snap = useSessionSnapshot(sessions, sessionId);
			const [collapsed, setCollapsed] = React.useState(false);
			const [geom, setGeom] = React.useState(null);
			const [focus, setFocus] = React.useState(null);
			const [currentIndex, setCurrentIndex] = React.useState(-1);
			const [capsuleHover, setCapsuleHover] = React.useState(false);
			const [grip, setGrip] = React.useState(false);
			const [fade, setFade] = React.useState(1);
			const [allMsgs, setAllMsgs] = React.useState(undefined); // undefined=加载中, null=失败, 数组=成功
			const [scrollTop, setScrollTop] = React.useState(0);
			const [hoveringTimeline, setHoveringTimeline] = React.useState(false);
			const segmentsRef = React.useRef([]);
			const zoneRef = React.useRef(null);
			const scrollerRef = React.useRef(null);
			const focusRef = React.useRef(null);
			const followRef = React.useRef(true);

			// 窗口内 segments（user/steering 节点）+ 其后的回复文本；记录 seq 用于映射全量索引
			const segments = React.useMemo(() => {
				if (!snap || !snap.chat) return [];
				const order = snap.chat.order || [];
				const nodes = snap.chat.nodes;
				if (!nodes || typeof nodes.get !== 'function') return [];
				const out = [];
				const replyParts = [];
				for (const key of order) {
					let node;
					try { node = nodes.get(key); } catch (error) { node = undefined; }
					if (!node) continue;
					if (node.kind === 'user' || node.kind === 'steering') {
						if (out.length > 0) {
							out[out.length - 1].reply = replyParts.join('\n').replace(/\s+/g, ' ').trim();
						}
						replyParts.length = 0;
						if (node.visibility === 'hidden') continue;
						const data = node.data || {};
						out.push({ key, seq: node.anchorSeq, time: data.time, text: previewOf(data.content), reply: '' });
					} else if (node.kind === 'assistant-step') {
						const data = node.data || {};
						const blocks = Array.isArray(data.blocks) ? data.blocks : [];
						for (const b of blocks) {
							if (b && typeof b === 'object' && b.kind === 'text' && typeof b.text === 'string') {
								replyParts.push(b.text);
							}
						}
					}
				}
				if (out.length > 0) {
					out[out.length - 1].reply = replyParts.join('\n').replace(/\s+/g, ' ').trim();
				}
				return out;
			}, [snap]);
			segmentsRef.current = segments;

			// 订阅全会话用户消息投影（host 侧增量 fold + 持久化缓存，刷新秒出）
			React.useEffect(() => {
				if (!sessionId) {
					setAllMsgs(undefined);
					return;
				}
				let face = null;
				try {
					const binding = sessions.binding(sessionId);
					face = binding && binding.session ? binding.session.projections.faceOf('timelineUserMessages') : null;
				} catch (error) {
					face = null;
				}
				if (!face) {
					setAllMsgs(undefined);
					return;
				}
				const read = () => {
					const v = face.getSnapshot();
					setAllMsgs(Array.isArray(v) ? v : (v === undefined ? undefined : []));
				};
				read();
				return face.subscribe(read);
			}, [sessions, sessionId]);

			// 测量滚动容器位置
			React.useEffect(() => {
				let observer = null;
				const measure = () => {
					const scrollport = document.querySelector('[data-conversation-scroll]');
					if (!scrollport) {
						setGeom(null);
						return;
					}
					const rect = scrollport.getBoundingClientRect();
					const seat = scrollport.querySelector('[data-composer-seat]');
					const seatRect = seat ? seat.getBoundingClientRect() : null;
					const top = rect.top + 12;
					const bottom = seatRect ? seatRect.top - 10 : rect.bottom - 12;
					setGeom({ left: rect.left + 6, top, height: Math.max(0, bottom - top) });
				};
				measure();
				if (typeof ResizeObserver !== 'undefined') {
					const scrollport = document.querySelector('[data-conversation-scroll]');
					if (scrollport) {
						observer = new ResizeObserver(measure);
						observer.observe(scrollport);
					}
				}
				window.addEventListener('resize', measure);
				return () => {
					if (observer) observer.disconnect();
					window.removeEventListener('resize', measure);
				};
			}, [snap, sessionId]);

			// 滚动时追踪"当前消息"（窗口内索引）
			React.useEffect(() => {
				let raf = 0;
				const update = () => {
					raf = 0;
					const scrollport = document.querySelector('[data-conversation-scroll]');
					const list = segmentsRef.current;
					if (!scrollport || list.length === 0) {
						setCurrentIndex(-1);
						return;
					}
					const top = scrollport.getBoundingClientRect().top;
					let best = -1;
					const rows = scrollport.querySelectorAll('[data-chat-anchor-key]');
					for (let i = 0; i < list.length; i++) {
						for (const row of rows) {
							if (row.dataset.chatAnchorKey === list[i].key) {
								if (row.getBoundingClientRect().top - top <= 96) best = i;
								break;
							}
						}
					}
					setCurrentIndex(best);
				};
				const onScroll = () => {
					if (!raf) raf = requestAnimationFrame(update);
				};
				document.addEventListener('scroll', onScroll, true);
				update();
				return () => {
					document.removeEventListener('scroll', onScroll, true);
					if (raf) cancelAnimationFrame(raf);
				};
			}, [segments]);

			// document 级兜底：鼠标坐标离开时间轴区域（含胶囊热区）即清除焦点
			React.useEffect(() => {
				const onDocMove = (e) => {
					const el = zoneRef.current;
					if (!el) return;
					const r = el.getBoundingClientRect();
					const inside = e.clientX >= r.left - 24 && e.clientX <= r.right + 24 && e.clientY >= r.top - 48 && e.clientY <= r.bottom + 10;
					if (!inside && focusRef.current !== null) {
						focusRef.current = null;
						setFocus(null);
					}
				};
				document.addEventListener('mousemove', onDocMove, true);
				return () => document.removeEventListener('mousemove', onDocMove, true);
			}, []);

			// 收起/展开时淡入淡出
			React.useEffect(() => {
				setFade(0);
				const raf = requestAnimationFrame(() => requestAnimationFrame(() => setFade(1)));
				return () => cancelAnimationFrame(raf);
			}, [collapsed]);

			// 显示阈值：undefined=加载中不渲染；null=失败降级窗口内逻辑；数组=按全会话条数
			const showByTotal = allMsgs === undefined ? false
				: allMsgs === null ? (segments.length >= 5 || (snap && snap.hasMore))
				: allMsgs.length >= 5;

			// 窗口内 segment -> 全量索引（按 seq 映射）
			const seqToTotalIndex = React.useCallback((seq) => {
				if (!Array.isArray(allMsgs)) return -1;
				for (let i = 0; i < allMsgs.length; i++) {
					if (allMsgs[i].seq === seq) return i;
				}
				return -1;
			}, [allMsgs]);
			const windowSeqAt = React.useCallback((idx) => {
				const list = segmentsRef.current;
				return idx >= 0 && idx < list.length ? list[idx].seq : null;
			}, []);

			// 判断某个 seq 是否已进入窗口（直接读 live snapshot，不等 React 渲染）
			const liveHasSeq = React.useCallback((seq) => {
				const face = sessions.binding(sessionId)?.session;
				if (!face) return false;
				let cur = null;
				try { cur = face.getSnapshot(); } catch (e) { return false; }
				if (!cur || !cur.chat) return false;
				const order = cur.chat.order || [];
				const nodes = cur.chat.nodes;
				if (!nodes || typeof nodes.get !== 'function') return false;
				for (const key of order) {
					let node;
					try { node = nodes.get(key); } catch (e) { node = undefined; }
					if (node && (node.kind === 'user' || node.kind === 'steering') && node.anchorSeq === seq) return true;
				}
				return false;
			}, [sessions, sessionId]);

			// 加载更早历史直到目标 seq 进入窗口（上限 60 次）
			const loadUntil = React.useCallback(async (seq) => {
				const face = sessions.binding(sessionId)?.session;
				if (!face) return false;
				for (let i = 0; i < 60; i++) {
					if (liveHasSeq(seq)) return true;
					try { await face.loadOlder(); } catch (e) { return false; }
					await new Promise((resolve) => requestAnimationFrame(() => resolve()));
				}
				return liveHasSeq(seq);
			}, [sessions, sessionId, liveHasSeq]);

			// 等待某条 segment 出现在已渲染的窗口数据里（rAF 轮询，上限约 2 秒）
			const waitForSeg = React.useCallback(async (seq) => {
				for (let i = 0; i < 120; i++) {
					const list = segmentsRef.current;
					for (const s of list) {
						if (s.seq === seq) return s;
					}
					await new Promise((resolve) => requestAnimationFrame(() => resolve()));
				}
				return null;
			}, []);

			// 点击：全量索引 -> 滚动到窗口内对应行；窗口外则先加载历史
			const jumpToTotal = React.useCallback(async (totalIdx) => {
				if (!Array.isArray(allMsgs)) return;
				const seq = allMsgs[totalIdx] && allMsgs[totalIdx].seq;
				if (typeof seq !== 'number') return;
				const loaded = await loadUntil(seq);
				const seg = await waitForSeg(seq);
				if (!loaded || !seg) {
					const scrollport = document.querySelector('[data-conversation-scroll]');
					if (scrollport) scrollport.scrollTop = 0;
					return;
				}
				const scrollport = document.querySelector('[data-conversation-scroll]');
				if (!scrollport) return;
				let row = null;
				for (const el of scrollport.querySelectorAll('[data-chat-anchor-key]')) {
					if (el.dataset.chatAnchorKey === seg.key) {
						row = el;
						break;
					}
				}
				if (!row) return;
				const spRect = scrollport.getBoundingClientRect();
				const rowRect = row.getBoundingClientRect();
				scrollport.scrollTop = scrollport.scrollTop + (rowRect.top - spRect.top) - 12;
				// 用户主动点击跳转：恢复自动跟随（此时黑条=目标条，语义正确）
				followRef.current = true;
			}, [allMsgs, loadUntil, waitForSeg]);

			// ---- 布局常量（在条件 return 之前计算，保证 hooks 顺序稳定） ----
			const n = Array.isArray(allMsgs) ? allMsgs.length : segments.length; // 总条数（全量优先，失败降级窗口内）
			const containerW = 16;   // 条所在内容区宽度
			const railW = 40;        // 含波浪伸展空间的滚动容器宽度（右侧为滚动条）
			const anchorX = containerW / 2;
			const buttonLeft = -5;
			const hitW = 26;
			const baseLen = 12;
			const maxLen = 30;
			const spacing = 14;      // 条间距：永远不变（超出时时间轴内部滚动，不压缩）
			const radius = 2.5;
			const capsuleRadius = 3;
			const hitH = spacing;
			const totalH = (n - 1) * spacing + baseLen; // 条区域总高度
			// 胶囊在可视区顶部的最小位置（钳制点）
			const capFixed = 12;
			// 内容顶部固定留白：胶囊钳制位置 + 1.3 格条距。
			// 保证滚动到顶时，第一条始终停在胶囊下方 1.3 格处，胶囊与第一条之间永远是空白。
			const topPad = capFixed + 1.3 * spacing;
			// 条区域可用高度：剩余可视区（若条太多则按 totalH，可滚动）
			const bodyH = geom ? Math.max(geom.height - topPad, totalH) : totalH;
			const startTop = Math.max(0, (bodyH - totalH) / 2); // 条区域内居中
			const contentH = topPad + bodyH; // 滚动容器内容总高度
			const capsuleCenterY = startTop - 1.3 * spacing; // 胶囊内容坐标（相对滚动容器）：第一条上方 1.3 格
			const capsuleLeft = anchorX - baseLen / 2 - 3;
			const capsuleCenterX = capsuleLeft + maxLen / 2;
			const primary = 'var(--dsw-alias-label-primary)';
			const activeColor = 'var(--dsw-alias-label-tertiary)';
			const borderL2 = 'var(--dsw-alias-border-l2)';

			// 当前消息（窗口内索引）映射为全量索引
			const currentTotalIndex = currentIndex >= 0 && windowSeqAt(currentIndex) !== null ? seqToTotalIndex(windowSeqAt(currentIndex)) : -1;

			// scroll-spy 联动：黑条不可见时自动滚动时间轴让其可见。
			// 用户手动滚动时间轴后（followRef=false）暂停跟随，不再回弹；
			// 只有点击某条跳转后（jumpToTotal 成功）才恢复跟随。
			React.useEffect(() => {
				const scroller = scrollerRef.current;
				if (!scroller) return;
				if (!followRef.current || hoveringTimeline) return;
				if (currentTotalIndex < 0) return;
				const y = startTop + currentTotalIndex * spacing;
				const viewH = scroller.clientHeight;
				if (y < scroller.scrollTop + 2) {
					scroller.scrollTop = Math.max(0, y - 4);
				} else if (y > scroller.scrollTop + viewH - 2) {
					scroller.scrollTop = Math.min(scroller.scrollHeight - viewH, y - viewH + 4);
				}
			}, [currentTotalIndex, startTop, spacing, hoveringTimeline, n, topPad]);

			if (!sessionId || !snap || !geom || !showByTotal) return null;

			const capsuleFocused = !collapsed && capsuleHover;
			const centerVal = capsuleFocused ? -1.5 : (focus !== null ? focus : currentTotalIndex);
			const centerIdx = centerVal === null || centerVal < 0 ? -1 : Math.round(centerVal);
			const weightOf = (i) => {
				if (capsuleFocused) {
					return Math.max(0, 1 - Math.abs(i + 1.5) / capsuleRadius);
				}
				if (centerVal === null || centerVal < 0) return 0;
				return Math.max(0, 1 - Math.abs(i - centerVal) / radius);
			};

			// 波浪坐标换算：鼠标在滚动容器中的位置 -> 内容坐标系
			const onMove = (e) => {
				const scroller = scrollerRef.current;
				if (!scroller) return;
				const rect = scroller.getBoundingClientRect();
				const contentY = scroller.scrollTop + (e.clientY - rect.top);
				const f = (contentY - startTop) / spacing;
				const v = Math.max(0, Math.min(n - 1, f));
				focusRef.current = v;
				setFocus(v);
			};
			const onLeave = () => {
				focusRef.current = null;
				setFocus(null);
				setCapsuleHover(false);
				setGrip(false);
				setHoveringTimeline(false);
				// 注意：不恢复 followRef —— 用户手动滚动过时间轴后保持当前位置，不回弹；
				// 只有点击某条跳转（jumpToTotal）才恢复自动跟随
			};

			const gripButton = React.createElement('button', {
				tabIndex: -1,
				title: '收起时间线',
				style: {
					position: 'absolute', left: capsuleLeft,
					width: maxLen, height: 10, borderRadius: 5, padding: 0, border: 'none',
					background: activeColor, opacity: capsuleHover ? 1 : 0,
					transition: 'opacity 100ms ease', pointerEvents: 'none',
				},
			});

			if (collapsed) {
				return React.createElement('div', {
					style: { position: 'fixed', left: geom.left + containerW / 2 - hitW / 2, top: geom.top, width: hitW, height: geom.height, pointerEvents: 'none', zIndex: 40, opacity: fade, transition: 'opacity 140ms ease' },
				}, [
					React.createElement('div', {
						key: 'bar',
						style: { position: 'absolute', left: hitW / 2 - 2, top: 0, width: 4, height: geom.height, borderRadius: 2, background: borderL2, opacity: grip ? 1 : 0, pointerEvents: 'none', transition: 'opacity 100ms ease' },
					}),
					React.createElement('div', {
						key: 'hot',
						title: '展开时间线',
						style: { position: 'absolute', left: 0, top: 0, width: hitW, height: geom.height, pointerEvents: 'auto', cursor: 'pointer' },
						onMouseEnter: () => setGrip(true),
						onMouseLeave: () => setGrip(false),
						onClick: () => setCollapsed(false),
					}),
				]);
			}

			// 内容层（高度 = 可视区与总内容取大，可滚动）
			const contentChildren = [];
			const lineLeft = anchorX - buttonLeft - baseLen / 2;
			for (let i = 0; i < n; i++) {
				const msg = Array.isArray(allMsgs) ? allMsgs[i] : null;
				const seg = msg ? segments.find((s) => s.seq === msg.seq) : undefined;
				const w = weightOf(i);
				const len = baseLen + (maxLen - baseLen) * w;
				const h = 2 + 2 * w;
				const isCenter = centerIdx === i && !capsuleFocused;
				const opacity = isCenter ? 1 : 0.12;
				contentChildren.push(React.createElement('button', {
					key: 'tl-' + i,
					onClick: () => jumpToTotal(i),
					style: {
						position: 'absolute', left: buttonLeft, top: startTop + i * spacing - hitH / 2,
						width: hitW, height: hitH, padding: 0, border: 'none',
						background: 'transparent', cursor: 'pointer', pointerEvents: 'auto', zIndex: 1,
					},
				}, React.createElement('span', {
					style: {
						position: 'absolute', left: lineLeft, top: '50%', transform: 'translateY(-50%)',
						width: len, height: h, borderRadius: 2, background: isCenter ? activeColor : primary, opacity,
						transition: 'width 120ms ease-out, height 120ms ease-out, opacity 120ms ease-out',
					},
				})));
			}

			// tooltip：基于内容坐标，减去滚动偏移得到可视坐标
			const hoveredIndex = !capsuleFocused && focus !== null ? Math.round(focus) : -1;
			let tipEl = null;
			if (hoveredIndex >= 0 && hoveredIndex < n) {
				const msg = Array.isArray(allMsgs) ? allMsgs[hoveredIndex] : null;
				const seg = msg ? segments.find((s) => s.seq === msg.seq) : undefined;
				const tipText = seg ? seg.text : (msg && msg.text ? msg.text : '更早消息');
				const tipReply = seg && seg.reply ? seg.reply : (msg && msg.reply ? msg.reply : '');
				const tipTime = msg && typeof msg.time === 'number' ? msg.time : 0;
				const tipContentY = topPad + startTop + hoveredIndex * spacing; // 屏幕坐标（滚动容器偏移 topPad）
				const tipY = tipContentY - scrollTop;
				tipEl = React.createElement('div', {
					key: 'tip',
					style: {
						position: 'absolute', left: hitW + 8, top: Math.max(4, Math.min(tipY - 28, geom.height - 120)),
						pointerEvents: 'none', minWidth: 340, maxWidth: 340, background: 'var(--dsw-alias-bg-layer-2)',
						border: '1px solid ' + borderL2, borderRadius: 8, padding: '8px 10px',
						boxShadow: '0 4px 14px rgba(0,0,0,.15)', zIndex: 50, overflow: 'hidden',
					},
				},
					React.createElement('div', {
						style: {
							whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
							fontSize: 16, lineHeight: '24px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
						},
					}, tipText),
					React.createElement('div', {
						style: { position: 'relative', marginTop: 4, minHeight: 24 },
					},
						tipReply ? React.createElement('div', {
							style: {
								display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
								overflow: 'hidden', wordBreak: 'break-word',
								fontSize: 16, lineHeight: '24px', color: 'var(--dsw-alias-label-secondary)',
							},
						}, tipReply) : null,
						React.createElement('div', {
							style: { position: 'absolute', right: 0, bottom: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', background: 'var(--dsw-alias-bg-layer-2)', paddingLeft: 12, paddingRight: 4, borderRadius: '4px 0 0 4px' },
						}, fmtTime(tipTime)),
					)
				);
			}

			// 胶囊可视位置（相对外层容器）：
			// 内容坐标（相对滚动容器）为 capsuleCenterY - scrollTop，再加滚动容器偏移 topPad；
			// 钳制在 [capFixed, geom.height - 20] —— 由于滚动容器从 topPad 开始且裁剪条目，
			// 条目可见区最低点 = topPad = capFixed + 1.3*spacing，任何滚动位置条目都不会进入胶囊区域
			const capsuleScreenY = Math.max(capFixed, Math.min(topPad + capsuleCenterY - scrollTop, geom.height - 20));

			return React.createElement('div', {
				ref: zoneRef,
				// 容器左缘贴对话区左缘（geom.left），条中线保持在原位置（anchorX），向右扩展容纳滚动条
				style: { position: 'fixed', left: geom.left, top: geom.top, width: railW, height: geom.height, pointerEvents: 'none', zIndex: 40, opacity: fade, transition: 'opacity 140ms ease' },
			}, [
				// 滚动容器：从胶囊下方 1.3 格处开始（topPad），条目被容器裁剪，
				// 永远不可能滚进胶囊区域（胶囊与第一条之间始终是空白）
				React.createElement('div', {
					key: 'scroller',
					ref: scrollerRef,
					className: 'dsh-tl-scroller',
					style: { position: 'absolute', left: 0, top: topPad, width: railW, height: Math.max(0, geom.height - topPad), overflowY: 'auto', overflowX: 'hidden', pointerEvents: 'auto', zIndex: 1, scrollbarWidth: 'none' },
					onScroll: (e) => setScrollTop(e.currentTarget.scrollTop),
					onWheel: () => { followRef.current = false; }, // 用户手动滚动 -> 暂停自动跟随，不回弹
					onMouseMove: onMove,
					onMouseEnter: () => { setHoveringTimeline(true); },
					onMouseLeave: onLeave,
				},
					React.createElement('div', {
						style: { position: 'relative', width: railW, height: bodyH },
					}, contentChildren)),
				// 胶囊热区 + 本体（可视区固定）
				React.createElement('div', {
					key: 'capsule-zone',
					title: '收起时间线',
					style: { position: 'absolute', left: capsuleCenterX - 18, top: capsuleScreenY - 12, width: 36, height: 24, pointerEvents: 'auto', cursor: 'pointer', zIndex: 3 },
					onMouseEnter: () => setCapsuleHover(true),
					onMouseLeave: () => setCapsuleHover(false),
					onClick: () => setCollapsed(true),
				}),
				React.createElement('div', {
					key: 'grip',
					style: { position: 'absolute', top: capsuleScreenY - 5, left: 0, right: 0, pointerEvents: 'none', zIndex: 4 },
				}, gripButton),
				tipEl,
			]);
		}

		// ---- 插件主体：注册到 frame-wide 浮层 ----
		function apply(ctx) {
			const slots = ctx.get('slots');
			const sessions = ctx.get('sessions');
			if (slots === undefined || sessions === undefined) return;
			// 隐藏滚动条样式（保留滚动功能）；去重防止重复插入
			if (!document.getElementById('dsh-tl-scroller-style')) {
				const style = document.createElement('style');
				style.id = 'dsh-tl-scroller-style';
				style.textContent = '.dsh-tl-scroller::-webkit-scrollbar{display:none}.dsh-tl-scroller{-ms-overflow-style:none}';
				document.head.appendChild(style);
			}
			slots.inject('shell.overlay', () => slots.register(
				{ name: 'shell.overlay', id: 'session-timeline', order: 10 },
				(props) => React.createElement(TimelineStrip, { sessions, useSessions: props.useSessions }),
			));
		}

		exports.apply = apply;
		return module.exports;
	}
});
