import { useState, useEffect, useRef, useCallback } from "react";
import {
	Terminal,
	Lock,
	Unlock,
	Cpu,
	Activity,
	Database,
	Shield,
	Send,
	X,
	CheckCircle,
	AlertTriangle,
	ChevronRight,
	Zap,
	Eye,
	EyeOff,
	Trash2,
	Plus,
	RotateCcw,
	Settings,
	BookOpen,
	FileText,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Message {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: number;
	taskId?: string;
	quotaWarning?: string;
}

interface Task {
	id: string;
	name: string;
	description: string;
	status:
		| "PENDING"
		| "RUNNING"
		| "AWAITING_CONFIRMATION"
		| "COMPLETED"
		| "FAILED"
		| "CANCELLED";
	progress: number;
	progressMessage?: string;
	pendingAction?: {
		tier: string;
		description: string;
		confirmationToken: string;
	};
	createdAt: number;
	completedAt?: number;
}

interface PendingConfirmation {
	confirmationId: string;
	tier: "READ" | "WRITE" | "DESTRUCTIVE";
	toolName: string;
	skillId: string;
	actionId: string;
	params: Record<string, unknown>;
	description: string;
}

interface QuotaSnapshot {
	rpm: { used: number; limit: number; resetInMs: number };
	tpm: { used: number; limit: number; resetInMs: number };
	rpd: { used: number; limit: number; resetInMs: number };
	queueDepth: number;
}

interface Secret {
	name: string;
	tier: string;
	description: string;
	updatedAt: number;
}

type View = "chat" | "tasks" | "memory" | "secrets" | "audit" | "settings";

// ─── WebSocket Hook ───────────────────────────────────────────────────────────

function useALAN(token: string | null) {
	const ws = useRef<WebSocket | null>(null);
	const [connected, setConnected] = useState(false);
	const [messages, setMessages] = useState<Message[]>([]);
	const [tasks, setTasks] = useState<Task[]>([]);
	const [thinking, setThinking] = useState(false);
	const [pendingConfirmations, setPendingConfirmations] = useState<
		PendingConfirmation[]
	>([]);

	const send = useCallback(
		(type: string, data?: unknown) => {
			if (ws.current?.readyState === WebSocket.OPEN) {
				ws.current.send(JSON.stringify({ type, data, token }));
			}
		},
		[token],
	);

	useEffect(() => {
		if (!token) return;

		const connect = () => {
			const socket = new WebSocket("ws://127.0.0.1:7432");
			ws.current = socket;

			socket.onopen = () => {
				socket.send(JSON.stringify({ type: "auth", token }));
			};

			socket.onmessage = (e) => {
				const { type, data } = JSON.parse(e.data);

				if (type === "auth:success") {
					setConnected(true);
				}
				if (type === "chat:thinking") {
					setThinking(true);
				}
				if (type === "chat:response") {
					setThinking(false);
					setMessages((prev) => [
						...prev,
						{
							...data.message,
							quotaWarning: data.quotaWarning,
						},
					]);
				}
				if (type === "chat:error") {
					setThinking(false);
					setMessages((prev) => [
						...prev,
						{
							id: crypto.randomUUID(),
							role: "system" as const,
							content: `⚠️ Error: ${data.message}`,
							timestamp: Date.now(),
						},
					]);
				}
				if (type === "task:update") {
					setTasks((prev) => {
						const idx = prev.findIndex((t) => t.id === data.taskId);
						if (idx >= 0) {
							const updated = [...prev];
							updated[idx] = { ...updated[idx], ...data.data };
							return updated;
						}
						return prev;
					});
					if (
						["COMPLETED", "FAILED", "AWAITING_CONFIRMATION"].includes(data.type)
					) {
						setMessages((prev) => [
							...prev,
							{
								id: crypto.randomUUID(),
								role: "system" as const,
								content: data.message,
								timestamp: Date.now(),
								taskId: data.taskId,
							},
						]);
					}
				}
				if (type === "confirmation:required") {
					setThinking(false);
					setPendingConfirmations((prev) => [
						...prev,
						data as PendingConfirmation,
					]);
				}
			};

			socket.onclose = () => {
				setConnected(false);
				setTimeout(connect, 3000);
			};
		};

		connect();
		return () => ws.current?.close();
	}, [token]);

	const chat = useCallback(
		(content: string) => {
			setMessages((prev) => [
				...prev,
				{
					id: crypto.randomUUID(),
					role: "user" as const,
					content,
					timestamp: Date.now(),
				},
			]);
			send("chat", { content });
		},
		[send],
	);

	return {
		connected,
		messages,
		tasks,
		setTasks,
		thinking,
		send,
		chat,
		pendingConfirmations,
		setPendingConfirmations,
	};
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SetupScreen({ onComplete }: { onComplete: (token: string) => void }) {
	const [passphrase, setPassphrase] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [isUnlock, setIsUnlock] = useState(false);
	const [checkingStatus, setCheckingStatus] = useState(true);

	useEffect(() => {
		fetch("/api/status")
			.then((r) => r.json())
			.then((s) => {
				setIsUnlock(s.initialized);
				setCheckingStatus(false);
			});
	}, []);

	const submit = async () => {
		if (passphrase.length < 8) {
			setError("Passphrase must be at least 8 characters");
			return;
		}
		setLoading(true);
		setError("");
		try {
			const endpoint = isUnlock ? "/api/vault/unlock" : "/api/vault/setup";
			const body = isUnlock
				? { passphrase }
				: { passphrase, geminiApiKey: apiKey };
			const res = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const data = await res.json();
			if (!res.ok) {
				setError(data.error);
				return;
			}
			onComplete(data.sessionToken);
		} catch {
			setError("Connection failed. Is ALAN running?");
		} finally {
			setLoading(false);
		}
	};

	if (checkingStatus)
		return (
			<div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
				<Cpu className="text-[#00ff88] animate-spin" size={32} />
			</div>
		);

	return (
		<div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center p-4">
			<div className="w-full max-w-md">
				<div className="text-center mb-10">
					<div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[#00ff88]/10 border border-[#00ff88]/20 mb-4">
						<Cpu className="text-[#00ff88]" size={32} />
					</div>
					<h1 className="text-3xl font-bold text-white tracking-tight">
						A.L.A.N.
					</h1>
					<p className="text-[#888] text-sm mt-1 font-mono">
						Autonomous Local Assistant Node
					</p>
				</div>

				<div className="bg-[#111118] border border-[#1e1e2e] rounded-2xl p-6 shadow-2xl">
					<div className="flex items-center gap-2 mb-6">
						<Lock size={16} className="text-[#00ff88]" />
						<span className="text-white font-medium">
							{isUnlock ? "Unlock Vault" : "Initialize Vault"}
						</span>
					</div>
					<div className="space-y-4">
						<div>
							<label className="text-[#888] text-xs font-mono uppercase tracking-wider block mb-2">
								Master Passphrase
							</label>
							<input
								type="password"
								value={passphrase}
								onChange={(e) => setPassphrase(e.target.value)}
								onKeyDown={(e) => e.key === "Enter" && submit()}
								placeholder="Minimum 8 characters"
								className="w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-xl px-4 py-3 text-white placeholder-[#444] focus:outline-none focus:border-[#00ff88]/50 transition-colors font-mono"
							/>
						</div>
						{!isUnlock && (
							<div>
								<label className="text-[#888] text-xs font-mono uppercase tracking-wider block mb-2">
									Gemini API Key
								</label>
								<div className="relative">
									<input
										type={showKey ? "text" : "password"}
										value={apiKey}
										onChange={(e) => setApiKey(e.target.value)}
										placeholder="AIza..."
										className="w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-xl px-4 py-3 text-white placeholder-[#444] focus:outline-none focus:border-[#00ff88]/50 transition-colors font-mono pr-12"
									/>
									<button
										onClick={() => setShowKey(!showKey)}
										className="absolute right-3 top-1/2 -translate-y-1/2 text-[#555] hover:text-[#888] transition-colors"
									>
										{showKey ? <EyeOff size={16} /> : <Eye size={16} />}
									</button>
								</div>
								<p className="text-[#555] text-xs mt-1.5 font-mono">
									Encrypted with AES-256-GCM. Never stored in plaintext.
								</p>
							</div>
						)}
						{error && (
							<div className="flex items-center gap-2 text-red-400 text-sm bg-red-400/10 rounded-lg px-3 py-2">
								<AlertTriangle size={14} /> {error}
							</div>
						)}
						<button
							onClick={submit}
							disabled={loading}
							className="w-full bg-[#00ff88] text-black font-bold py-3 rounded-xl hover:bg-[#00e87a] transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
						>
							{loading ? (
								<RotateCcw size={16} className="animate-spin" />
							) : (
								<Unlock size={16} />
							)}
							{loading
								? "Processing..."
								: isUnlock
									? "Unlock"
									: "Initialize & Start"}
						</button>
					</div>
				</div>

				<div className="flex items-center justify-center gap-2 mt-6 text-[#333] text-xs font-mono">
					<Shield size={12} className="text-[#00ff88]/40" />
					<span>Local-only • AES-256-GCM • Argon2id KDF</span>
				</div>
			</div>
		</div>
	);
}

function QuotaBar({
	label,
	used,
	limit,
}: {
	label: string;
	used: number;
	limit: number;
}) {
	const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
	const color = pct > 80 ? "#ff4444" : pct > 60 ? "#ffaa00" : "#00ff88";
	return (
		<div>
			<div className="flex justify-between text-xs font-mono mb-1">
				<span className="text-[#666]">{label}</span>
				<span style={{ color }}>
					{used}/{limit}
				</span>
			</div>
			<div className="h-1 bg-[#1a1a2e] rounded-full overflow-hidden">
				<div
					className="h-full rounded-full transition-all duration-500"
					style={{ width: `${pct}%`, backgroundColor: color }}
				/>
			</div>
		</div>
	);
}

function TaskCard({
	task,
	onConfirm,
	onCancel,
}: {
	task: Task;
	onConfirm: (id: string, approved: boolean) => void;
	onCancel: (id: string) => void;
}) {
	const statusColors: Record<string, string> = {
		PENDING: "#666",
		RUNNING: "#00ff88",
		AWAITING_CONFIRMATION: "#ffaa00",
		COMPLETED: "#00aaff",
		FAILED: "#ff4444",
		CANCELLED: "#444",
	};
	const color = statusColors[task.status] ?? "#666";

	return (
		<div className="bg-[#0d0d1a] border border-[#1a1a2e] rounded-xl p-4 space-y-3">
			<div className="flex items-start justify-between gap-2">
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2">
						<div
							className="w-2 h-2 rounded-full flex-shrink-0"
							style={{ backgroundColor: color }}
						/>
						<span className="text-white text-sm font-medium truncate">
							{task.name}
						</span>
					</div>
					<p className="text-[#555] text-xs mt-1 ml-4">{task.description}</p>
				</div>
				{["PENDING", "RUNNING", "AWAITING_CONFIRMATION"].includes(
					task.status,
				) && (
					<button
						onClick={() => onCancel(task.id)}
						className="text-[#555] hover:text-[#ff4444] transition-colors flex-shrink-0"
					>
						<X size={14} />
					</button>
				)}
			</div>
			{task.status === "RUNNING" && (
				<div>
					<div className="h-1 bg-[#1a1a2e] rounded-full overflow-hidden">
						<div
							className="h-full bg-[#00ff88] rounded-full transition-all duration-300"
							style={{ width: `${task.progress}%` }}
						/>
					</div>
					{task.progressMessage && (
						<p className="text-[#555] text-xs mt-1 font-mono">
							{task.progressMessage}
						</p>
					)}
				</div>
			)}
			{task.status === "AWAITING_CONFIRMATION" && task.pendingAction && (
				<div className="border border-[#ffaa00]/30 bg-[#ffaa00]/5 rounded-lg p-3 space-y-2">
					<div className="flex items-center gap-2">
						<AlertTriangle size={14} className="text-[#ffaa00]" />
						<span className="text-[#ffaa00] text-xs font-mono uppercase">
							{task.pendingAction.tier} action required
						</span>
					</div>
					<p className="text-[#ccc] text-sm">
						{task.pendingAction.description}
					</p>
					<div className="flex gap-2">
						<button
							onClick={() => onConfirm(task.id, true)}
							className="flex-1 bg-[#00ff88]/10 hover:bg-[#00ff88]/20 text-[#00ff88] border border-[#00ff88]/30 rounded-lg py-1.5 text-xs font-mono flex items-center justify-center gap-1 transition-colors"
						>
							<CheckCircle size={12} /> Approve
						</button>
						<button
							onClick={() => onConfirm(task.id, false)}
							className="flex-1 bg-[#ff4444]/10 hover:bg-[#ff4444]/20 text-[#ff4444] border border-[#ff4444]/30 rounded-lg py-1.5 text-xs font-mono flex items-center justify-center gap-1 transition-colors"
						>
							<X size={12} /> Deny
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

function ChatMsg({ msg }: { msg: Message }) {
	if (msg.role === "system") {
		const isTask = msg.taskId !== undefined;
		const isError = msg.content.startsWith("⚠️");
		return (
			<div
				className={`flex items-start gap-2 py-2 px-3 rounded-lg mx-4 my-1 text-sm border
        ${
					isError
						? "bg-red-400/10 text-red-400 border-red-400/20"
						: isTask
							? "bg-[#00ff88]/5 text-[#00ff88]/80 border-[#00ff88]/20"
							: "bg-[#1a1a2e] text-[#666] border-transparent"
				}`}
			>
				{isTask ? (
					<Activity size={14} className="mt-0.5 flex-shrink-0" />
				) : (
					<Zap size={14} className="mt-0.5 flex-shrink-0" />
				)}
				<span className="font-mono text-xs">{msg.content}</span>
			</div>
		);
	}
	if (msg.role === "user") {
		return (
			<div className="flex justify-end px-4 my-2">
				<div className="max-w-[75%] bg-[#00ff88]/10 border border-[#00ff88]/20 rounded-2xl rounded-tr-sm px-4 py-3">
					<p className="text-white text-sm leading-relaxed">{msg.content}</p>
				</div>
			</div>
		);
	}
	return (
		<div className="flex gap-3 px-4 my-2">
			<div className="w-7 h-7 rounded-lg bg-[#00ff88]/10 border border-[#00ff88]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
				<Cpu size={14} className="text-[#00ff88]" />
			</div>
			<div className="flex-1 min-w-0">
				<div className="bg-[#111118] border border-[#1e1e2e] rounded-2xl rounded-tl-sm px-4 py-3">
					<p className="text-[#ddd] text-sm leading-relaxed whitespace-pre-wrap">
						{msg.content}
					</p>
				</div>
				{msg.quotaWarning && (
					<p className="text-[#ffaa00] text-xs font-mono mt-1 ml-2">
						⚡ {msg.quotaWarning}
					</p>
				)}
				<p className="text-[#333] text-xs font-mono mt-1 ml-2">
					{new Date(msg.timestamp).toLocaleTimeString()}
				</p>
			</div>
		</div>
	);
}

function ConfirmationBanner({
	confirmation,
	onRespond,
}: {
	confirmation: PendingConfirmation;
	onRespond: (id: string, approved: boolean) => void;
}) {
	const isDestructive = confirmation.tier === "DESTRUCTIVE";
	const borderColor = isDestructive
		? "border-[#ff4444]/40"
		: "border-[#ffaa00]/40";
	const bgColor = isDestructive ? "bg-[#ff4444]/5" : "bg-[#ffaa00]/5";
	const accentColor = isDestructive ? "text-[#ff4444]" : "text-[#ffaa00]";

	return (
		<div
			className={`mx-4 mb-2 border ${borderColor} ${bgColor} rounded-xl p-4 space-y-3`}
		>
			<div className="flex items-center gap-2">
				<AlertTriangle size={15} className={accentColor} />
				<span
					className={`text-xs font-mono uppercase tracking-wider font-bold ${accentColor}`}
				>
					{confirmation.tier} action — approval required
				</span>
			</div>
			<p className="text-[#ccc] text-sm font-mono">
				{confirmation.description}
			</p>
			{Object.keys(confirmation.params).length > 0 && (
				<div className="bg-[#0a0a0f] rounded-lg p-2 text-xs font-mono text-[#555] space-y-0.5">
					{Object.entries(confirmation.params).map(([k, v]) => (
						<div key={k}>
							<span className="text-[#444]">{k}:</span>{" "}
							<span className="text-[#777]">"{String(v)}"</span>
						</div>
					))}
				</div>
			)}
			<div className="flex gap-2">
				<button
					onClick={() => onRespond(confirmation.confirmationId, true)}
					className="flex-1 bg-[#00ff88]/10 hover:bg-[#00ff88]/20 text-[#00ff88] border border-[#00ff88]/30 rounded-lg py-2 text-xs font-mono flex items-center justify-center gap-1.5 transition-colors font-bold"
				>
					<CheckCircle size={13} /> Approve
				</button>
				<button
					onClick={() => onRespond(confirmation.confirmationId, false)}
					className="flex-1 bg-[#1a1a2e] hover:bg-[#ff4444]/10 text-[#666] hover:text-[#ff4444] border border-[#1a1a2e] hover:border-[#ff4444]/30 rounded-lg py-2 text-xs font-mono flex items-center justify-center gap-1.5 transition-colors"
				>
					<X size={13} /> Deny
				</button>
			</div>
		</div>
	);
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
	const [token, setToken] = useState<string | null>(null);
	const [view, setView] = useState<View>("chat");
	const [input, setInput] = useState("");
	const [quota, setQuota] = useState<QuotaSnapshot | null>(null);
	const [secrets, setSecrets] = useState<Secret[]>([]);
	const [memories, setMemories] = useState<
		{ id: string; summary: string; tags: string[]; importance: number }[]
	>([]);
	const [newSecret, setNewSecret] = useState({
		name: "",
		value: "",
		tier: "RUNTIME",
		description: "",
	});
	const [showNewSecret, setShowNewSecret] = useState(false);
	const [auditLog, setAuditLog] = useState<unknown[]>([]);
	const messagesEnd = useRef<HTMLDivElement>(null);

	const {
		connected,
		messages,
		tasks,
		setTasks,
		thinking,
		send,
		chat,
		pendingConfirmations,
		setPendingConfirmations,
	} = useALAN(token);

	const authFetch = useCallback(
		(url: string, opts: RequestInit = {}) => {
			return fetch(url, {
				...opts,
				headers: {
					...((opts.headers as Record<string, string>) ?? {}),
					"x-alan-token": token ?? "",
				},
			});
		},
		[token],
	);

	useEffect(() => {
		messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages, thinking, pendingConfirmations]);

	useEffect(() => {
		if (!token) return;
		const interval = setInterval(() => {
			authFetch("/api/quota")
				.then((r) => r.json())
				.then(setQuota)
				.catch(() => {});
		}, 5000);
		authFetch("/api/quota")
			.then((r) => r.json())
			.then(setQuota)
			.catch(() => {});
		authFetch("/api/tasks")
			.then((r) => r.json())
			.then((d) => setTasks(d.tasks ?? []))
			.catch(() => {});
		return () => clearInterval(interval);
	}, [token, authFetch]);

	useEffect(() => {
		if (!token || view !== "secrets") return;
		authFetch("/api/secrets")
			.then((r) => r.json())
			.then((d) => setSecrets(d.secrets ?? []));
	}, [token, view, authFetch]);

	useEffect(() => {
		if (!token || view !== "memory") return;
		authFetch("/api/memory")
			.then((r) => r.json())
			.then((d) => setMemories(d.memories ?? []));
	}, [token, view, authFetch]);

	useEffect(() => {
		if (!token || view !== "audit") return;
		authFetch("/api/audit")
			.then((r) => r.json())
			.then((d) => setAuditLog(d.log ?? []));
	}, [token, view, authFetch]);

	// Task-engine confirmation (background tasks)
	const handleTaskConfirm = (taskId: string, approved: boolean) => {
		send("task:confirm", { taskId, approved });
		authFetch(`/api/tasks/${taskId}/confirm`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ approved }),
		});
	};

	// Inline tool confirmation (WRITE/DESTRUCTIVE actions in main agent loop)
	const handleInlineConfirm = (confirmationId: string, approved: boolean) => {
		send("confirmation:respond", { confirmationId, approved });
		authFetch(`/api/confirmations/${confirmationId}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ approved }),
		});
		setPendingConfirmations((prev) =>
			prev.filter((c) => c.confirmationId !== confirmationId),
		);
	};

	const handleTaskCancel = (taskId: string) => {
		send("task:cancel", { taskId });
		authFetch(`/api/tasks/${taskId}`, { method: "DELETE" });
	};

	const handleSend = () => {
		if (!input.trim() || thinking) return;
		chat(input.trim());
		setInput("");
	};

	const handleAddSecret = async () => {
		if (!newSecret.name || !newSecret.value) return;
		await authFetch("/api/secrets", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(newSecret),
		});
		setShowNewSecret(false);
		setNewSecret({ name: "", value: "", tier: "RUNTIME", description: "" });
		authFetch("/api/secrets")
			.then((r) => r.json())
			.then((d) => setSecrets(d.secrets ?? []));
	};

	const activeTasks = tasks.filter((t) =>
		["PENDING", "RUNNING", "AWAITING_CONFIRMATION"].includes(t.status),
	);
	const awaitingConfirmation = tasks.filter(
		(t) => t.status === "AWAITING_CONFIRMATION",
	);

	if (!token) return <SetupScreen onComplete={setToken} />;

	const navItems: {
		id: View;
		icon: React.ReactNode;
		label: string;
		badge?: number;
	}[] = [
		{
			id: "chat",
			icon: <Terminal size={16} />,
			label: "Chat",
			badge: pendingConfirmations.length || undefined,
		},
		{
			id: "tasks",
			icon: <Activity size={16} />,
			label: "Tasks",
			badge: activeTasks.length || undefined,
		},
		{ id: "memory", icon: <BookOpen size={16} />, label: "Memory" },
		{ id: "secrets", icon: <Shield size={16} />, label: "Secrets" },
		{ id: "audit", icon: <FileText size={16} />, label: "Audit" },
		{ id: "settings", icon: <Settings size={16} />, label: "Settings" },
	];

	return (
		<div
			className="h-screen bg-[#0a0a0f] text-white flex overflow-hidden"
			style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}
		>
			{/* ── Sidebar ── */}
			<div className="w-56 flex-shrink-0 bg-[#0d0d16] border-r border-[#1a1a2e] flex flex-col">
				<div className="p-4 border-b border-[#1a1a2e]">
					<div className="flex items-center gap-2.5">
						<div className="w-8 h-8 rounded-lg bg-[#00ff88]/10 border border-[#00ff88]/20 flex items-center justify-center">
							<Cpu size={16} className="text-[#00ff88]" />
						</div>
						<div>
							<div className="text-white font-bold text-sm tracking-widest">
								A.L.A.N.
							</div>
							<div className="text-[#444] text-xs">v1.0.0</div>
						</div>
					</div>
				</div>

				<div className="px-4 py-2 border-b border-[#1a1a2e]">
					<div className="flex items-center gap-2">
						<div
							className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-[#00ff88]" : "bg-[#ff4444]"}`}
							style={connected ? { boxShadow: "0 0 6px #00ff88" } : {}}
						/>
						<span className="text-xs text-[#555]">
							{connected ? "Connected" : "Reconnecting..."}
						</span>
					</div>
				</div>

				<nav className="flex-1 p-2 space-y-0.5">
					{navItems.map((item) => (
						<button
							key={item.id}
							onClick={() => setView(item.id)}
							className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all relative
                ${
									view === item.id
										? "bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/20"
										: "text-[#555] hover:text-[#888] hover:bg-[#111] border border-transparent"
								}`}
						>
							{item.icon}
							{item.label}
							{item.badge ? (
								<span className="ml-auto bg-[#ffaa00] text-black text-xs font-bold rounded-full w-4 h-4 flex items-center justify-center">
									{item.badge}
								</span>
							) : null}
						</button>
					))}
				</nav>

				{quota && (
					<div className="p-3 border-t border-[#1a1a2e] space-y-2">
						<QuotaBar
							label="RPM"
							used={quota.rpm.used}
							limit={quota.rpm.limit}
						/>
						<QuotaBar
							label="RPD"
							used={quota.rpd.used}
							limit={quota.rpd.limit}
						/>
					</div>
				)}
			</div>

			{/* ── Main content ── */}
			<div className="flex-1 flex flex-col min-w-0">
				{/* Header */}
				<div className="h-12 border-b border-[#1a1a2e] flex items-center px-4 gap-3 flex-shrink-0">
					<span className="text-[#00ff88] text-xs font-mono uppercase tracking-widest">
						{view}
					</span>
					{awaitingConfirmation.length > 0 && (
						<div className="flex items-center gap-1.5 bg-[#ffaa00]/10 border border-[#ffaa00]/30 rounded-lg px-2 py-1 text-[#ffaa00] text-xs">
							<AlertTriangle size={12} />
							{awaitingConfirmation.length} task action
							{awaitingConfirmation.length > 1 ? "s" : ""} awaiting approval
						</div>
					)}
				</div>

				{/* ── CHAT ── */}
				{view === "chat" && (
					<div className="flex-1 flex flex-col min-h-0">
						<div className="flex-1 overflow-y-auto py-4">
							{messages.length === 0 && (
								<div className="flex flex-col items-center justify-center h-full text-center p-8">
									<div className="w-16 h-16 rounded-2xl bg-[#00ff88]/5 border border-[#00ff88]/10 flex items-center justify-center mb-4">
										<Cpu size={28} className="text-[#00ff88]/40" />
									</div>
									<p className="text-[#333] text-sm">
										Start a conversation with A.L.A.N.
									</p>
									<p className="text-[#222] text-xs mt-1">
										Try: "Search my Desktop for any text files"
									</p>
								</div>
							)}
							{messages.map((m) => (
								<ChatMsg key={m.id} msg={m} />
							))}
							{thinking && (
								<div className="flex gap-3 px-4 my-2">
									<div className="w-7 h-7 rounded-lg bg-[#00ff88]/10 border border-[#00ff88]/20 flex items-center justify-center flex-shrink-0">
										<Cpu size={14} className="text-[#00ff88] animate-pulse" />
									</div>
									<div className="bg-[#111118] border border-[#1e1e2e] rounded-2xl rounded-tl-sm px-4 py-3">
										<div className="flex gap-1">
											{[0, 1, 2].map((i) => (
												<div
													key={i}
													className="w-1.5 h-1.5 rounded-full bg-[#00ff88]/40 animate-bounce"
													style={{ animationDelay: `${i * 150}ms` }}
												/>
											))}
										</div>
									</div>
								</div>
							)}
							<div ref={messagesEnd} />
						</div>

						{/* Inline confirmation banners — appear above the input */}
						{pendingConfirmations.map((c) => (
							<ConfirmationBanner
								key={c.confirmationId}
								confirmation={c}
								onRespond={handleInlineConfirm}
							/>
						))}

						<div className="p-4 border-t border-[#1a1a2e]">
							<div className="flex gap-2 bg-[#111118] border border-[#1e1e2e] rounded-xl p-1 focus-within:border-[#00ff88]/30 transition-colors">
								<input
									value={input}
									onChange={(e) => setInput(e.target.value)}
									onKeyDown={(e) =>
										e.key === "Enter" && !e.shiftKey && handleSend()
									}
									placeholder="Message A.L.A.N..."
									disabled={!connected || thinking}
									className="flex-1 bg-transparent px-3 py-2 text-white placeholder-[#333] focus:outline-none text-sm disabled:opacity-50"
								/>
								<button
									onClick={handleSend}
									disabled={!input.trim() || !connected || thinking}
									className="bg-[#00ff88] text-black rounded-lg px-3 py-2 hover:bg-[#00e87a] transition-colors disabled:opacity-30 flex items-center gap-1.5 text-sm font-bold"
								>
									<Send size={14} />
								</button>
							</div>
						</div>
					</div>
				)}

				{/* ── TASKS ── */}
				{view === "tasks" && (
					<div className="flex-1 overflow-y-auto p-4 space-y-3">
						{tasks.length === 0 && (
							<div className="text-center py-16 text-[#333] text-sm">
								No tasks yet
							</div>
						)}
						{tasks.map((t) => (
							<TaskCard
								key={t.id}
								task={t}
								onConfirm={handleTaskConfirm}
								onCancel={handleTaskCancel}
							/>
						))}
					</div>
				)}

				{/* ── MEMORY ── */}
				{view === "memory" && (
					<div className="flex-1 overflow-y-auto p-4 space-y-2">
						<div className="flex justify-end mb-2">
							<button
								onClick={() => {
									authFetch("/api/memory", { method: "DELETE" }).then(() =>
										setMemories([]),
									);
								}}
								className="flex items-center gap-1.5 text-[#ff4444]/60 hover:text-[#ff4444] text-xs transition-colors"
							>
								<Trash2 size={12} /> Clear all memories
							</button>
						</div>
						{memories.length === 0 && (
							<div className="text-center py-16 text-[#333] text-sm">
								No memories stored
							</div>
						)}
						{memories.map((m) => (
							<div
								key={m.id}
								className="bg-[#0d0d1a] border border-[#1a1a2e] rounded-xl p-3 flex items-start gap-3"
							>
								<Database
									size={14}
									className="text-[#333] mt-0.5 flex-shrink-0"
								/>
								<div className="flex-1 min-w-0">
									<p className="text-[#ccc] text-sm">{m.summary}</p>
									<div className="flex gap-1 mt-1 flex-wrap">
										{m.tags.map((t) => (
											<span
												key={t}
												className="text-[#555] text-xs bg-[#1a1a2e] rounded px-1.5 py-0.5"
											>
												{t}
											</span>
										))}
									</div>
								</div>
								<button
									onClick={() => {
										authFetch(`/api/memory/${m.id}`, { method: "DELETE" }).then(
											() =>
												setMemories((prev) =>
													prev.filter((x) => x.id !== m.id),
												),
										);
									}}
									className="text-[#333] hover:text-[#ff4444] transition-colors flex-shrink-0"
								>
									<X size={14} />
								</button>
							</div>
						))}
					</div>
				)}

				{/* ── SECRETS ── */}
				{view === "secrets" && (
					<div className="flex-1 overflow-y-auto p-4 space-y-3">
						<div className="bg-[#ffaa00]/5 border border-[#ffaa00]/20 rounded-xl p-3 flex items-start gap-2 text-xs text-[#ffaa00]/80">
							<Shield size={14} className="flex-shrink-0 mt-0.5" />
							<span>
								Secret values are never displayed. All secrets are AES-256-GCM
								encrypted at rest.
							</span>
						</div>

						<button
							onClick={() => setShowNewSecret(true)}
							className="w-full border border-dashed border-[#1a1a2e] rounded-xl p-3 text-[#333] hover:border-[#00ff88]/30 hover:text-[#00ff88]/60 transition-colors flex items-center justify-center gap-2 text-sm"
						>
							<Plus size={14} /> Add Secret
						</button>

						{showNewSecret && (
							<div className="bg-[#0d0d1a] border border-[#1a1a2e] rounded-xl p-4 space-y-3">
								<input
									placeholder="name (e.g. gemini.api_key)"
									value={newSecret.name}
									onChange={(e) =>
										setNewSecret((s) => ({ ...s, name: e.target.value }))
									}
									className="w-full bg-[#0a0a0f] border border-[#1a1a2e] rounded-lg px-3 py-2 text-white placeholder-[#333] text-sm focus:outline-none focus:border-[#00ff88]/30"
								/>
								<input
									type="password"
									placeholder="secret value"
									value={newSecret.value}
									onChange={(e) =>
										setNewSecret((s) => ({ ...s, value: e.target.value }))
									}
									className="w-full bg-[#0a0a0f] border border-[#1a1a2e] rounded-lg px-3 py-2 text-white placeholder-[#333] text-sm focus:outline-none focus:border-[#00ff88]/30"
								/>
								<input
									placeholder="description"
									value={newSecret.description}
									onChange={(e) =>
										setNewSecret((s) => ({ ...s, description: e.target.value }))
									}
									className="w-full bg-[#0a0a0f] border border-[#1a1a2e] rounded-lg px-3 py-2 text-white placeholder-[#333] text-sm focus:outline-none focus:border-[#00ff88]/30"
								/>
								<select
									value={newSecret.tier}
									onChange={(e) =>
										setNewSecret((s) => ({ ...s, tier: e.target.value }))
									}
									className="w-full bg-[#0a0a0f] border border-[#1a1a2e] rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
								>
									<option value="RUNTIME">RUNTIME (auto-injected)</option>
									<option value="SKILL">SKILL (scoped to skill)</option>
									<option value="ADMIN">ADMIN (manual only)</option>
								</select>
								<div className="flex gap-2">
									<button
										onClick={handleAddSecret}
										className="flex-1 bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/30 rounded-lg py-2 text-sm hover:bg-[#00ff88]/20 transition-colors"
									>
										Save
									</button>
									<button
										onClick={() => setShowNewSecret(false)}
										className="flex-1 bg-[#1a1a2e] text-[#666] rounded-lg py-2 text-sm hover:text-white transition-colors"
									>
										Cancel
									</button>
								</div>
							</div>
						)}

						{secrets.map((s) => (
							<div
								key={s.name}
								className="bg-[#0d0d1a] border border-[#1a1a2e] rounded-xl p-3 flex items-center gap-3"
							>
								<Lock size={14} className="text-[#00ff88]/40 flex-shrink-0" />
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2">
										<span className="text-white text-sm font-mono">
											{s.name}
										</span>
										<span
											className={`text-xs px-1.5 py-0.5 rounded font-mono
                      ${
												s.tier === "RUNTIME"
													? "bg-[#00ff88]/10 text-[#00ff88]/60"
													: s.tier === "SKILL"
														? "bg-[#00aaff]/10 text-[#00aaff]/60"
														: "bg-[#ffaa00]/10 text-[#ffaa00]/60"
											}`}
										>
											{s.tier}
										</span>
									</div>
									<p className="text-[#444] text-xs mt-0.5">{s.description}</p>
								</div>
								<button
									onClick={() => {
										authFetch(`/api/secrets/${s.name}`, {
											method: "DELETE",
										}).then(() =>
											setSecrets((prev) =>
												prev.filter((x) => x.name !== s.name),
											),
										);
									}}
									className="text-[#333] hover:text-[#ff4444] transition-colors flex-shrink-0"
								>
									<Trash2 size={14} />
								</button>
							</div>
						))}
					</div>
				)}

				{/* ── AUDIT ── */}
				{view === "audit" && (
					<div className="flex-1 overflow-y-auto p-4">
						<div className="space-y-1">
							{(
								auditLog as Array<{
									id: number;
									ts: number;
									actor: string;
									action: string;
									target: string;
									tier: string;
									result: string;
								}>
							).map((entry) => (
								<div
									key={entry.id}
									className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-[#0d0d1a] transition-colors text-xs font-mono"
								>
									<span className="text-[#333] w-20 flex-shrink-0">
										{new Date(entry.ts).toLocaleTimeString()}
									</span>
									<span className="text-[#00aaff]/60 w-24 flex-shrink-0 truncate">
										{entry.actor}
									</span>
									<span className="text-[#888] flex-1 truncate">
										{entry.action} → {entry.target}
									</span>
									<span
										className={`flex-shrink-0 ${
											entry.result.startsWith("SUCCESS")
												? "text-[#00ff88]/60"
												: entry.result.startsWith("DENIED")
													? "text-[#ffaa00]/60"
													: "text-[#ff4444]/60"
										}`}
									>
										{entry.result}
									</span>
								</div>
							))}
							{auditLog.length === 0 && (
								<div className="text-center py-16 text-[#333] text-sm">
									No audit entries
								</div>
							)}
						</div>
					</div>
				)}

				{/* ── SETTINGS ── */}
				{view === "settings" && (
					<div className="flex-1 overflow-y-auto p-4 space-y-4">
						{quota && (
							<div className="bg-[#0d0d1a] border border-[#1a1a2e] rounded-xl p-4 space-y-3">
								<h3 className="text-[#888] text-xs uppercase tracking-wider">
									Gemini Quota
								</h3>
								<QuotaBar
									label="Requests / min"
									used={quota.rpm.used}
									limit={quota.rpm.limit}
								/>
								<QuotaBar
									label="Tokens / min"
									used={quota.tpm.used}
									limit={quota.tpm.limit}
								/>
								<QuotaBar
									label="Requests / day"
									used={quota.rpd.used}
									limit={quota.rpd.limit}
								/>
								<button
									onClick={() =>
										authFetch("/api/settings/rate-limit-tier", {
											method: "POST",
											headers: { "Content-Type": "application/json" },
											body: JSON.stringify({ tier: "paid" }),
										})
									}
									className="text-xs text-[#00ff88]/60 hover:text-[#00ff88] transition-colors flex items-center gap-1"
								>
									<ChevronRight size={12} /> Switch to Paid Tier limits
								</button>
							</div>
						)}
						<div className="bg-[#0d0d1a] border border-[#1a1a2e] rounded-xl p-4 space-y-2">
							<h3 className="text-[#888] text-xs uppercase tracking-wider">
								Security
							</h3>
							{[
								"AES-256-GCM vault encryption",
								"Argon2id key derivation (64MB, 3 passes)",
								"Localhost-only binding (127.0.0.1)",
								"Session tokens rotated on every restart",
								"Skill secret scope isolation",
								"Immutable audit log",
							].map((item) => (
								<div
									key={item}
									className="flex items-center gap-2 text-xs text-[#555]"
								>
									<Shield size={12} className="text-[#00ff88]/40" /> {item}
								</div>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
