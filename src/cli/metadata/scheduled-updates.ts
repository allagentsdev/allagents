import type { CommandWorkflow } from '../help.js';

export const scheduledUpdatesWorkflow: CommandWorkflow = {
  id: 'scheduled-updates',
  description:
    'Set up user-owned external scheduling of scoped resource updates when explicitly requested.',
  steps: [
    "Establish the update target and cadence from the user's request and context; ask only for missing choices. This workflow schedules resource updates; CLI upgrades use self update.",
    "Follow update's structured help to choose supported --scope or --profile selectors; they cannot be combined. User scope includes installed profiles. Resolve a stable executable, working directory, and environment that work unattended.",
    'Configure a suitable existing host scheduler to run that command. Reuse a matching job and preserve unrelated scheduler configuration.',
    'Verify the scheduled command executes successfully in its unattended environment. Report the schedule, execution result, and how to inspect logs/status and remove the job.',
  ],
};
