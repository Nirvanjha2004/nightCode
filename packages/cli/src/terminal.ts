import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createElement } from "react";
import type { AgentLoop } from "../src/agent/loop";
import { App } from "./index";
import { logger } from "./logger";

export class TerminalUI {
    constructor(
        private sessionId: string,
        private agentLoop: AgentLoop
    ) {}

    async start(): Promise<void> {
        logger.info("TerminalUI.start() — creating CLI renderer");

        try {
            // 1. Create the native CLI renderer instance
            const renderer = await createCliRenderer({
                exitOnCtrlC: true,
            });
            logger.debug("CLI renderer created successfully");

            // 2. Mount and render your React tree using createRoot
            createRoot(renderer).render(
                createElement(App, {
                    sessionId: this.sessionId,
                    agentLoop: this.agentLoop,
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