import { CopyButton, CopyField } from '~/components/ui';
import { AGENT_SETUP_PROMPT, CLI_INSTALL_COMMAND } from '~/lib/links';

/**
 * Two ways in without the desktop app: paste a prompt into your coding
 * agent and it sets Peko up, or run the install command yourself.
 */
export function AgentSetup() {
  return (
    <div className="space-y-6">
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-ink-700 px-4 py-2.5">
          <span className="text-sm font-medium text-slate-200">Prompt for your agent</span>
          <CopyButton value={AGENT_SETUP_PROMPT} label="Copy prompt" className="btn-primary btn-sm" />
        </div>
        <pre
          className="max-h-64 overflow-auto whitespace-pre-wrap px-4 py-3.5 font-mono text-[12.5px] leading-relaxed text-slate-400"
          data-testid="agent-prompt"
        >
          {AGENT_SETUP_PROMPT}
        </pre>
      </div>
      <div>
        <p className="mb-2 text-sm text-slate-400">Or install it yourself</p>
        <CopyField value={CLI_INSTALL_COMMAND} />
      </div>
    </div>
  );
}
