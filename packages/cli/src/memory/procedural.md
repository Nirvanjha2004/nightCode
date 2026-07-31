1. [task execution] buildMemoryContext must be called before task execution
2. [task completion] onTaskComplete must be called after task execution
3. [file deletion request] always check if file exists before attempting to delete
4. [file not found with find] Always use glob to search for files if find is not sufficient.
5. [file deletion failed] Use delete to remove files if they exist, and glob to find them if find is not working.
