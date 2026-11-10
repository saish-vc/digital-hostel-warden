// vitest setupFiles entry: runs before every test file's module graph, so the
// app's module-level env reads (JWT_SECRET, ESCALATION_DELAY_MS, DATABASE_URL)
// see the test configuration.
import './testEnv';
