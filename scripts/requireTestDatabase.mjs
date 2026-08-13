if (!process.env.TEST_DATABASE_URL) {
  console.error("TEST_DATABASE_URL is required for the PostgreSQL release gate.");
  process.exit(1);
}
