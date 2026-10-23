-- The studio agent is gone: the platform's assistant in the hub shell replaced it, and its
-- StudioAssistant objects were deleted with their conversations. Its thread directory goes too.
DROP INDEX IF EXISTS assistant_threads_by_owner;
DROP TABLE IF EXISTS assistant_threads;
