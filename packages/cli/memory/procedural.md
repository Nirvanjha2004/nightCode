1. [unknown command] ask for context when encountering unknown commands
2. [unknown command in user query] request tools when unknown command is given
3. [unknown command] When encountering an unknown command, ask for context or clarification.
4. [when slash_commands are not supported] use_plain_language_for_requests
5. [tools return no output] ask for project or directory path if tools return no output
6. [unsupported slash commands] use direct tool calls
7. [commit request] use 'Commit the changes with message' for git commit
8. [tools return no output] request additional context when tools return no output
9. [subagent access request] always request user confirmation for subagent access
10. [tool call failure] check environment status before proceeding
11. [spawn_subagent with write permissions] request_confirmation_before_write_access
12. [subagent write permissions requested] request confirmation before spawning subagent with write permissions
13. [spawn_subagent] Request user confirmation for write access before spawning subagent
14. [spawn_subagent] always confirm write access before spawning a subagent
15. [git commit] use git add and git commit separately to avoid errors
