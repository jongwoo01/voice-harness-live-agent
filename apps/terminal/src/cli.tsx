#!/usr/bin/env node
import React from 'react';
import { Command } from 'commander';
import { render } from 'ink';
import type { AgentStatus } from '@google-live-agent/contracts';
import { createLogger } from '@google-live-agent/observability';
import App from './ui/App.js';

const logger = createLogger('terminal');

const program = new Command();

program
  .name('google-live-agent-terminal')
  .description('Terminal layer for Google Live Agent')
  .version('0.2.0');

program
  .command('status')
  .description('Print terminal and orchestration status')
  .action(() => {
    const status: AgentStatus = {
      session_id: 'local-bootstrap',
      task_id: 'T02A',
      stage: 'terminal_ready',
      updated_at: new Date().toISOString()
    };
    logger.info('terminal_status', status);
    console.log('terminal: ready');
    console.log('brain endpoint: http://localhost:8080');
    console.log(`stage: ${status.stage}`);
  });

program
  .command('tui')
  .description('Launch minimal terminal interface')
  .option('-m, --message <text>', 'Initial message', 'ambient orchestration online')
  .action((options: { message: string }) => {
    const { unmount } = render(
      <App
        message={options.message}
        onExit={() => {
          unmount();
          process.exit(0);
        }}
      />
    );
  });

if (process.argv.length <= 2) {
  program.parse([process.argv[0], process.argv[1], 'status']);
} else {
  program.parse();
}
