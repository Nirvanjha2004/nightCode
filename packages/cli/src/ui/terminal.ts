import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createElement } from "react";
import type { AgentLoop } from "../agent/loop";
import type { Command } from "./commands-menu/types";
import type { ModelMenuData } from "./model-menu/types";
import { App } from "./index";
import { logger } from "../logger";

export type ModelStateProps = {
    /** Currently active model id (shown in the status bar). */
    model: string;
    /** Currently active provider id. */
    providerId: string;
    /** Build the model-selector list (fresh on each menu open). */
    getModelOptions: () => ModelMenuData;
    /** Swap the backend router to a new provider/model; returns the new identity. */
    onSwitchModel: (providerId: string, modelId: string) => { providerId: string; modelId: string };
};

export class TerminalUI {
    constructor(
        private sessionId: string,
        private agentLoop: AgentLoop,
        private commands: Command[] = [],
        private modelState: ModelStateProps,
        private sessionNumber: number = 1,
        private onResetSession: () => { sessionId: string; sessionNumber: number }
    ) {}

    async start(): Promise<void> {
        logger.info("TerminalUI.start() — creating CLI renderer");

        try {
            // 1. Create the native CLI renderer instance.
            // Ctrl+C is owned by the App's keyboard handler: first press cancels
            // an active agent run, a second press (or a press while idle) exits
            // via renderer.destroy() — the same exit path exitOnCtrlC used.
            const renderer = await createCliRenderer({
                exitOnCtrlC: false,
            });
            logger.debug("CLI renderer created successfully");

            // 2. Mount and render your React tree using createRoot
            createRoot(renderer).render(
                createElement(App, {
                    sessionId: this.sessionId,
                    sessionNumber: this.sessionNumber,
                    agentLoop: this.agentLoop,
                    commands: this.commands,
                    model: this.modelState.model,
                    providerId: this.modelState.providerId,
                    getModelOptions: this.modelState.getModelOptions,
                    onSwitchModel: this.modelState.onSwitchModel,
                    onResetSession: this.onResetSession,
                })
            );
            logger.info(`Terminal UI mounted (sessionId=${this.sessionId})`);
        } catch (err) {
            logger.error(`Failed to start TerminalUI: ${err instanceof Error ? err.message : String(err)}`, {
                stack: err instanceof Error ? err.stack : undefined,
            });
            throw err;
        }
    }
}
