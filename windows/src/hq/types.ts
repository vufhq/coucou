// Coucou HQ: the window where the user runs Mochi and his team.
// The shared shapes between the store (store.ts, model.ts), the sidebar
// (sidebar.ts, avatar.ts, activity.ts), the conversation (conversation.ts,
// thread.ts, composer.ts, palette.ts) and the side panel (panel.ts). Each part
// only talks to the others through these.

import type { OrchAgent, OrchApproval, OrchAttachment, OrchComputer, OrchTask, OrchTeam } from "../core/orchestrator";

/** A file already handed to the backend for the next message. */
export interface SentFile {
  id: string;
  name: string;
  bytes: number;
}

/** One message between two agents, inside an exchange ("2 messages with Ada and Linus"). */
export interface ExchangeMessage {
  fromAgentId: string;
  toAgentId: string;
  text: string;
  at: string;
  taskId: string;
}

/** What a conversation shows, oldest first. `key` is stable across rebuilds. */
export type ThreadItem =
  /** A time separator ("Yesterday 12:27 AM"), before a message more than an hour after the last. */
  | { kind: "time"; key: string; at: string }
  /** What the user wrote. */
  | { kind: "user"; key: string; taskId: string; text: string; at: string; attachments?: OrchAttachment[] }
  /** What the agent answered (Markdown), with the files its task made. */
  | { kind: "agent"; key: string; taskId: string; agentId: string; markdown: string; at: string; artifacts: string[]; failed: boolean }
  /**
   * Agents talking among themselves, folded into one line:
   * - in Mochi's conversation: the work he handed out and the reports;
   * - in a coworker's: Mochi's message and the coworker's reply.
   */
  | { kind: "exchange"; key: string; taskId: string; withAgentIds: string[]; messages: ExchangeMessage[] }
  /** The agent is working on this task right now: a one-line status. */
  | { kind: "live"; key: string; taskId: string; line: string }
  /** A step that waits for the user's click. */
  | { kind: "approval"; key: string; approval: OrchApproval }
  /** The agent asks the user something (only in a task the user started). */
  | { kind: "question"; key: string; taskId: string; questionId: string; text: string; options: string[] };

/** What the main column shows: one agent's conversation, or every task (Activity). */
export type HqView = "chat" | "activity";
/** The side panel on the right: the agent's computer, goals, memory and files, or its settings. */
export type HqPanel = "agent" | "settings";

export interface HqSnapshot {
  /** The backend answered the last request. */
  connected: boolean;
  /** Why not, in words for the user. */
  error: string | null;
  agents: OrchAgent[];
  teams: OrchTeam[];
  computers: OrchComputer[];
  approvals: OrchApproval[];
  /** The conversation on screen. The chief by default. */
  selectedId: string | null;
  view: HqView;
  /** The side panel, or null when it is closed. */
  panel: HqPanel | null;
}

export interface HqStore {
  snapshot(): HqSnapshot;
  /** Called after any change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Loads everything once and starts listening to the backend's events. */
  start(): Promise<void>;
  reload(): Promise<void>;
  /** Selects an agent and shows its conversation (view "chat"). */
  select(agentId: string): void;
  setView(view: HqView): void;
  setPanel(panel: HqPanel | null): void;
  agent(agentId: string): OrchAgent | undefined;
  /** The chief (Mochi). */
  chief(): OrchAgent | undefined;
  /** The agent's conversation. Empty until loaded; loading starts on first ask. */
  thread(agentId: string): ThreadItem[];
  /** The last message, on one line, for the sidebar. "" when there is none. */
  preview(agentId: string): string;
  /** An approval or a question (in a task the user started) waits for the user. */
  needsYou(agentId: string): boolean;
  /** The agent is working on something. */
  working(agentId: string): boolean;
  /** When the agent's conversation last changed (its newest task), for the sidebar. Null when it has none. */
  lastAt(agentId: string): string | null;
  /** The agent's newest unfinished task (queued, running or waiting), or null. */
  current(agentId: string): OrchTask | null;
  /** Every recent task of every agent, newest first, fetched now (Activity, the computer's queue). */
  activity(): Promise<OrchTask[]>;
  /** Cancels a task. Rejects when the backend refused. Called only from an explicit click. */
  stop(taskId: string): Promise<void>;
  /**
   * Sends what the user typed: answers the pending question, or starts a chat
   * task with `files` (from OrchestratorBridge.attach) and the GitHub links in
   * the text. Rejects files with an answer: they need a new message.
   */
  send(agentId: string, text: string, files?: readonly SentFile[]): Promise<void>;
  answer(taskId: string, questionId: string, text: string): Promise<void>;
  decide(approval: OrchApproval, approve: boolean): Promise<void>;
  /** Saves one of a task's files where the user chooses; resolves to the saved path. */
  saveFile(agentId: string, taskId: string, path: string): Promise<string>;
}
