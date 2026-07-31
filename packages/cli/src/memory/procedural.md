1. [task execution] buildMemoryContext must be called before task execution
2. [task completion] onTaskComplete must be called after task execution
3. [file deletion request] always check if file exists before attempting to delete
4. [file not found with find] Always use glob to search for files if find is not sufficient.
5. [file deletion failed] Use delete to remove files if they exist, and glob to find them if find is not working.
6. [user requests package management] check for available package managers before attempting to install/uninstall
7. [user request to run shell commands] check for bash/terminal backend before running shell commands
8. [user request to use a tool] check for available tools before attempting to use them
9. [user request to run a shell command] check for terminal backend configuration before attempting to run shell commands
10. [user inquiry about access] request bash access before proceeding
11. [pip install command] Always check if a package is already installed before installing it
12. [pip install command followed by pip uninstall command] Uninstall a package immediately after installing it if not needed
13. [pip uninstall command] Use the -y flag with pip uninstall to automatically confirm uninstallation
