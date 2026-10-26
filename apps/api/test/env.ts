// Point every Prisma client in the test process at the isolated test database.
if (process.env.DATABASE_URL && !/_test(\?|$)/.test(process.env.DATABASE_URL)) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/\/([^/?]+)(\?|$)/, "/$1_test$2");
}
delete process.env.ORBIX_LLM_API_KEY;
