// Example geo-loop config. Copy to your project root as geo-loop.config.ts.
export default {
  brand: { name: "Acme", domain: "acme.dev", aliases: ["Acme.dev"] },
  site: { baseUrl: "https://acme.dev", blogPath: "/blog/" },
  positioning: {
    line: "Acme keeps your pipelines green.",
    bannedPhrases: ["revolutionary", "game-changing"],
  },
  productFactsFile: "product-facts.md", // the only numbers drafts may use besides cited sources
  questions: [
    { id: "q1", topic: "reliability", text: "How do I stop my data pipelines from failing silently?" },
    { id: "q2", topic: "comparisons", text: "Acme vs Airflow: which is better for a small team?" },
  ],
  competitors: { comparisons: ["https://airflow.apache.org/"] }, // eval fallback when engines cite nothing
  engines: [{ id: "claude" }, { id: "chatgpt" }, { id: "perplexity" }],
  judge: { model: "claude-opus-5-5", k: 10 },
  // sanity: { projectId: "abc123", dataset: "production" },
  // github: { repo: "acme/web", allowlist: ["public/llms.txt", "app/sitemap.ts"] },
};
