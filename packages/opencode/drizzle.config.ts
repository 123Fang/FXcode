import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/**/*.sql.ts",
  out: "./migration",
  dbCredentials: {
    // url: "/home/thdxr/.local/share/opencode/opencode.db",
    url: "/Users/fangxiang/.local/share/opencode/opencode-local.db"
  },
})
