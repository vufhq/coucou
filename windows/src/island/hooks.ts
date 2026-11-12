// What the orchestrator's agents are doing → island state.
//
// src-tauri/src/orchestrator.rs turns the backend's task events into events on
// the island's "hook" channel, named and shaped like Claude Code's hook events
// (UserPromptSubmit, PreToolUse, PermissionRequest, Stop…) and tagged with the
// agent in `vufh_agent`. This file moves the agent's pill accordingly and
// puts its approval requests on the island's card. Anything untagged is ignored.

import { onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { toOneLine } from "../core/text";
import { agentColor, validateAgent } from "./agents";
import { registerOrchestratorAgents } from "./orchestrator-agents";
import { registerAgentChat } from "./agent-chat";
import type { Island } from "./island";
import { N_, t } from "../i18n/i18n";

/** Approval requests the orchestrator backend owns (see orchestrator.rs). */
export function isOrchestratorRequest(requestId: string | undefined): boolean {
  return requestId?.startsWith("orch:") ?? false;
}

/** Clears the approval card if nobody answers it in time. */
let pendingTimeout: number | null = null;

/** Takes the approval card down and gives the island back. */
export function dropPendingCard(island: Island): void {
  if (!State.pendingApproval) return;
  State.endApproval();
  island.dropPin();
  if (State.view === "approval") island.setView(State.defaultView());
  State.notify();
}

/** The return to idle that Stop arms, per pill, so the next task can cancel it. */
const stopTimers = new Map<string, number>();

function cancelStopTimer(id: string): boolean {
  const timer = stopTimers.get(id);
  if (timer == null) return false;
  window.clearTimeout(timer);
  stopTimers.delete(id);
  return true;
}

/** Events after which a pending approval of the same task is moot. */
const TURN_OVER = new Set(["Stop", "StopFailure", "UserPromptSubmit", "SessionEnd"]);

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  /** `orch:<taskId>`: the task the event belongs to. */
  session_id?: string;
  message?: string;
  prompt?: string;
  /** Stop: the task's summary (Markdown). */
  last_assistant_message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** The orchestrator agent's id. */
  vufh_agent?: string;
}

/** Ticker labels for the tool names orchestrator.rs gives the island. */
const TOOL_LABELS: Record<string, string> = {
  Bash: N_("Runs"),
  Read: N_("Reads"),
  Write: N_("Writes"),
  WebFetch: N_("Fetches"),
  LS: N_("Lists"),
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ? t(TOOL_LABELS[tool]) : tool;
  const query = typeof input.query === "string" ? input.query : "";
  return query ? `${label} · ${query.slice(0, 40)}` : label;
}

/** What the Allow button authorises: the operation and its target. */
function approvalTarget(tool: string, input: Record<string, unknown>): string {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  return command ? `${tool} · ${command}` : tool;
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
  registerOrchestratorAgents();
  registerAgentChat();
  // An approval answered elsewhere (HQ, the Tasks page): the card goes.
  void onEvent<{ requestId: string }>("orchestrator-approval-resolved", ({ requestId }) => {
    if (State.pendingApproval?.requestId !== requestId) return;
    if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
    pendingTimeout = null;
    dropPendingCard(island);
  });
}

function handleHook(island: Island, payload: HookPayload) {
  // Paused: nothing shows. An approval stays pending in the backend, where HQ
  // can still answer it.
  if (State.paused) return;
  const agent = validateAgent(payload.vufh_agent);
  if (!agent) return;

  const name = payload.hook_event_name ?? "";
  const agentId = `agent_${agent}`;
  const sessionId = payload.session_id ?? "";

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  /** The agent's pill, made with its id until the agent list names it. */
  const ensurePill = () => State.upsertExternalAgent(agentId, agent, agentColor(agent));

  /** A newer state replaces `finished`: the timer Stop armed must not undo it. */
  const supersedeStop = () => {
    if (cancelStopTimer(agentId)) State.setPillBadge(agentId, null);
  };

  const clearFinalLine = () => {
    const task = State.tasks.find((x) => x.id === agentId);
    if (task) task.finalLine = null;
  };

  // The task that asked is over or moved on: its card would be lying.
  const pending = State.pendingApproval;
  if (pending && TURN_OVER.has(name) && pending.pillId === agentId && pending.sessionId === sessionId) {
    if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
    pendingTimeout = null;
    dropPendingCard(island);
  }

  // Read after the card above is dropped: its pill may have handed the front back.
  const focused = State.focusId === agentId;

  switch (name) {
    case "UserPromptSubmit": {
      ensurePill();
      supersedeStop();
      clearFinalLine();
      State.updateTask(agentId, "thinking");
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendStep(agentId, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse":
      ensurePill();
      supersedeStop();
      clearFinalLine();
      State.updateTask(agentId, "working");
      State.appendStep(agentId, stepLabel(payload.tool_name ?? "Tool", payload.tool_input ?? {}));
      surface("overview", false);
      break;

    case "PostToolUseFailure":
      supersedeStop();
      State.updateTask(agentId, "working");
      State.appendStep(agentId, t("⚠ failed"));
      break;

    case "Stop": {
      State.updateTask(agentId, "finished");
      const finalText = toOneLine(payload.last_assistant_message ?? payload.message ?? "");
      if (finalText) {
        State.appendStep(agentId, finalText);
        const task = State.tasks.find((x) => x.id === agentId);
        if (task) task.finalLine = finalText;
      }
      Sound.play("finish");
      // A card waiting for an answer is never covered by another alert.
      if (focused && !State.pendingApproval) surface("finished", true);
      else State.setPillBadge(agentId, "finished");
      cancelStopTimer(agentId);
      stopTimers.set(
        agentId,
        window.setTimeout(() => {
          stopTimers.delete(agentId);
          State.removeTask(agentId);
        }, 5200),
      );
      break;
    }

    case "StopFailure":
      supersedeStop();
      State.updateTask(agentId, "error");
      Sound.play("error");
      if (focused && !State.pendingApproval) surface("error", true);
      else State.setPillBadge(agentId, "error");
      break;

    case "SessionEnd":
      // The task was cancelled. The timer must not outlive it: a pill made
      // again within 5.2 s would be removed by it.
      cancelStopTimer(agentId);
      State.removeTask(agentId);
      break;

    case "PermissionRequest": {
      if (!isOrchestratorRequest(payload.request_id)) break;
      const requestId = payload.request_id ?? "";
      // One card, one request: a second one waits in the backend, and HQ shows it.
      if (State.pendingApproval && State.pendingApproval.requestId !== requestId) break;
      ensurePill();
      supersedeStop();
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const tool = payload.tool_name ?? "Tool";
      // The card always comes up, even over another pill: its pill comes to the
      // front, and the one you were on comes back once you answer.
      State.beginApproval({
        requestId,
        sessionId,
        pillId: agentId,
        tool,
        command: approvalTarget(tool, payload.tool_input ?? {}),
      });
      State.updateTask(agentId, "approval");
      Sound.play("approval");
      island.alert("approval");
      // The card goes after a while; the request stays pending in HQ.
      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        dropPendingCard(island);
      }, 110_000);
      break;
    }

    default:
      break;
  }
  State.notify();
}
