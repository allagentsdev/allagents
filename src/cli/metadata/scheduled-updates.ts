import type { CommandWorkflow } from '../help.js';

export const scheduledUpdatesWorkflow: CommandWorkflow = {
  id: 'scheduled-updates',
  description:
    'Set up optional, user-owned external scheduling of scoped AllAgents updates when the user explicitly requests it.',
  steps: [
    'Establish the requested update target, cadence, timezone, and missed-run policy before changing scheduler state. This recipe schedules resource reconciliation with update, not upgrading the AllAgents executable with self update. If the request is ambiguous, ask which they mean. Schedule setup requires an explicit user request; merely reading help or using update does not authorize it. Keep client launch behavior unchanged.',
    'Discover the installed contract through allagents --help --json, then follow help_command to update and any needed profile list/status or workspace status leaf. Use only advertised commands and flags. Choose an explicit --scope project, --scope user, or repeatable --profile <name>; --profile and --scope cannot be combined. User scope includes installed global profiles. Use --scope all only when the user requests all targets. For project/all scope, select the exact project directory; for user/profile updates, choose a stable existing directory outside an unrelated project. Confirm selected profiles are installed and declared before scheduling.',
    'Resolve a stable absolute executable and its runtime, not a shell alias or a temporary npx cache path. Discovery may use the skill-selected runner, but an unattended job needs a persistent installation; if only npx is available, arrange an explicitly requested persistent install before scheduling. Record absolute working directory, HOME, PATH (including Node/Bun, Git, and required client executables), and any required XDG/config or credential-helper environment. Check that remote authentication works without terminal input. Keep secrets out of displayed commands and scheduler files. Use --json and closed stdin for unattended updates, with only selectors/non-interactive flags advertised by the leaf; do not add --yes unless its specific write-back approval is intended.',
    'Inspect existing jobs and their actual command, scope/profile, and working directory across available user schedulers before choosing a stable, target-specific job name. Reuse a matching job; if the same name has unrelated content, choose another name. Preserve unrelated entries, unit files, environment settings, and permissions. Show the fully resolved command, scheduler file or crontab diff, cadence/timezone, logs, and removal commands before applying setup. The examples below are templates: replace every /ABS/... path, example name, cadence, and selector with the agreed values and escape for the scheduler syntax. Prepare log directories. Account for long-running jobs with scheduler overlap prevention or a host-supported lock when needed.',
    `On Linux with an available systemd user manager, use a user service and timer, for example ~/.config/systemd/user/allagents-update-user.service:
[Unit]
Description=AllAgents user resource update
[Service]
Type=oneshot
WorkingDirectory=/ABS/WORKDIR
Environment="HOME=/ABS/HOME" "PATH=/ABS/RUNTIME_BIN:/usr/local/bin:/usr/bin:/bin"
ExecStart=/ABS/ALLAGENTS update --scope user --json
StandardInput=null
StandardOutput=journal
StandardError=journal

And allagents-update-user.timer in the same directory:
[Unit]
Description=Daily AllAgents user resource update
[Timer]
OnCalendar=*-*-* 09:00:00
Persistent=true
[Install]
WantedBy=timers.target

This example uses local time and catches up missed runs when the timer becomes active. Adapt both to the requested policy. Quote paths containing spaces and escape systemd specifiers such as literal % as %%; ExecStart is not a shell command. Validate with systemd-analyze --user verify <service-path> <timer-path> and systemd-analyze calendar <expression>, then systemctl --user daemon-reload and systemctl --user enable --now allagents-update-user.timer. The user manager must be running for the timer to run; explain login/session limits and ask before changing linger policy. Inspect systemctl --user list-timers --all and systemctl --user status allagents-update-user.service; read journalctl --user -u allagents-update-user.service. Remove with systemctl --user disable --now allagents-update-user.timer, stop the matching service if active, systemctl --user clean --what=state allagents-update-user.timer, delete only this job's service/timer files, then daemon-reload. Reference: https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html`,
    `On a Unix host using cron, back up the current user's crontab with crontab -l, distinguishing no crontab from a read failure. Edit a fresh copy and replace only a matching marked block; preserve all other bytes and recheck for concurrent edits before installing it with crontab <reviewed-file>. Example daily block (one physical command line):
# BEGIN allagents-update-user
0 9 * * * ( cd '/ABS/WORKDIR' && /usr/bin/env HOME='/ABS/HOME' PATH='/ABS/RUNTIME_BIN:/usr/local/bin:/usr/bin:/bin' '/ABS/ALLAGENTS' update --scope user --json; result=$?; echo "allagents exit=$result"; exit "$result" ) </dev/null >>'/ABS/LOGDIR/allagents-update-user.log' 2>&1
# END allagents-update-user

Use the host cron timezone semantics; cron skips runs while the host is off/asleep. Shell-quote paths and escape every literal % in the crontab command as \\% even inside quotes. Keep environment assignments job-local. Inspect crontab -l and the log (including the recorded exit status); arrange log retention. Remove only this marked block from a fresh crontab copy, review the diff, and install the remainder; never use crontab -r. Reference: https://www.man7.org/linux/man-pages/man5/crontab.5.html`,
    'For other platforms, use the user scheduler supported on that host and discover its local command syntax before preparing the concrete configuration. On macOS, prefer a user LaunchAgent: a unique Label, absolute ProgramArguments, WorkingDirectory, EnvironmentVariables, StartCalendarInterval, and StandardOutPath/StandardErrorPath; validate the plist and inspect launchctl help for bootstrap, print, kickstart, and bootout. On Windows, use a named Task Scheduler task under the requesting user, with an absolute action/runtime, arguments, working directory, explicit trigger, output/error logs and no-overlap policy; discover the ScheduledTasks PowerShell cmdlets or schtasks help, and provide query/run/disable/unregister commands. Apply the same review, duplicate detection, verification, and removal rules, removing only the selected job and its files. Platform references: https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html and https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-start-page',
    'Verify before declaring completion: first run the resolved update command with the agreed working directory and minimal scheduler environment, closed stdin, and --dry-run if advertised. A dry run does not prove a real update or remote authentication succeeded. After applying the requested setup, inspect the installed definition and next trigger, then trigger this job once through its scheduler (for cron, run the exact installed command under the same environment). Check exit status and structured result/logs, and use the discovered read-only status command for the same project/profile where supported. Verify exactly one matching job exists and unrelated entries are unchanged. Report job identity, scope/profiles, executable, directory, environment requirements, cadence/timezone, next run, observed result, logs/status and clean removal. Report unavailable scheduler access, failed authentication, or partial updates as incomplete verification; do not claim success from file creation alone.',
  ],
};
