# Saved commands and workflows (0.2.0-alpha.5)

Commands & workflows is a local library available across server changes and app restarts. Add, edit or delete definitions without connecting. Nothing runs when selecting, editing, connecting or restarting. Deletion requires native confirmation and removes only the local definition.

## Create and run

1. Choose New workflow, or Example workflow to populate a generic, non-destructive example. Neither button executes commands. Review every command before saving or running.
2. Enter a name, optional description, and a working directory starting with `/` or `~/` (or `~` for the remote home). Put the directory here instead of a standalone `cd` step.
3. Enter one complete noninteractive command per line. Each step opens a separate remote POSIX shell in the chosen directory. Shell variables, environment exports and directory changes made by an earlier step do not persist. A step can contain deliberate compound shell syntax, but only its final exit status determines failure. Interactive programs and sudo/password prompts are not supported in this results panel; use the interactive terminal for those.
4. Optionally define variables, one per line: `user_id:integer:User ID` or `search:text:Search text`. Use a whole unquoted argument such as `my-command --user-id {{user_id}}`. Do not embed a placeholder in an existing quoted string or filename; pass a complete path as its own variable instead. Directory placeholders such as `/srv/{{project}}` are allowed and the entire directory is quoted.
5. Save, select the workflow and enter its variable values. Preview workflow shows the connected server and exact executable scripts with values substituted and argument quoting visible. Ask for confirmation before running is checked by default. Confirm and run opens a native warning with those same scripts and server, defaulting to Cancel. Turning the setting off requires a native safety warning when saving; submitting the preview then runs without a second dialog. The preference applies on all servers. Execution tokens never apply across reconnects or saved-definition changes. Preview tokens expire after five minutes and cannot be replayed.
6. Read streamed stdout/stderr and the current step status. Steps execute sequentially and stop on a nonzero exit, missing exit status, channel failure, timeout or cancellation. There is no automatic retry, restart of a stopped service, rollback or replay after reconnect. Existing terminal input is not used.

7. After a completed, failed or stopped run, choose Run again to reload the latest saved definition and start from step 1. Variable values must be entered again. With confirmation enabled, a fresh preview and native server confirmation are required. With confirmation disabled and no variables, clicking Run again starts immediately on the current connection; with variables, enter them again and submit the new preview. Deleted definitions cannot be rerun. Inspect uncertain previous outcomes before repeating commands; this is not resume or rollback. Rerun availability and results clear on disconnect. Definitions created before the confirmation preference was introduced default to confirmation enabled.

Text variables are quoted as data for the outer POSIX shell; integer variables require a signed whole number of at most 15 digits. Variable steps refuse command/arithmetic substitutions, parameter-expansion expressions, backticks and heredocs because those contexts need a full shell parser. Custom commands remain arbitrary remote code: do not feed variables to `eval`, shell `-c`, program code interpreters or other commands that reinterpret data as code. Quoting does not sandbox the application invoked by a command, establish that it is read-only, or validate its business-specific arguments.

## Generic example

The System check example uses the remote home directory. Its three steps print the working directory, show the operating system with `uname -s`, and print a message supplied through `{{message}}`. It does not stop services, delete files or use any real server, project, dataset or container names. Edit the example to suit your own environment and review the substituted preview before execution.

## Limits and stopping

At most one workflow runs at a time. Transfers, recovery and explorer file mutations cannot start while it runs, and a workflow cannot start during those operations. Manual terminal commands and other writers remain outside this coordination.

Up to 100 definitions and 2 MiB of local storage, 32 steps, 16 variables, 1,024 characters per value, 8 KiB per expanded command and 24 KiB total expanded commands, 32 KiB for the full executable preview are supported. Channel setup is bounded to 30 seconds. Maximum runtime per command is configurable from 1–120 minutes. This is a limit, not a delay: commands start immediately and advance as soon as they succeed. Follow-last-step mode permits up to 12 hours. A 2 MiB combined output limit stops the workflow; the UI keeps only the latest 128K characters. A bounded result is preferable to unbounded memory use. Shell scripts are displayed as text, never rendered as HTML.

Stop requests an interrupt and closes the current command channel. SSH channel closure cannot guarantee termination of remote processes, containers, background jobs or descendants. A timeout, disconnect or lost exit status can leave remote work running. Inspect the server before retrying; Stop does not undo completed steps. Disconnect clears displayed workflow results and entered values; definitions stay available.

## Local data and release scope

Definitions are stored in a versioned `workflows.json` in the application's user-data directory. They are **unencrypted**, like ordinary configuration; never save passwords, private keys or tokens in command text, defaults or descriptions. Entered variable values, approvals and output are not written to this file. Native dialogs and remote programs can still expose command arguments; server logging and remote process lifetimes are not controlled by SSHDrop. This is not an appropriate channel for sensitive secrets.

Writes are serialized and replace the configuration atomically. Invalid or oversized data blocks changes and is preserved. No import/export, command risk classifier, secret-variable vault, automatic scheduling or unattended execution is included. Desktop Windows/macOS/Linux support does not imply support for Windows PowerShell/cmd remote shells; this initial workflow mode requires a POSIX remote shell.
