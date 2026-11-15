import type { Command } from "commander";
import type { Ctx } from "../cli.js";
import { ptToMd } from "../lib/portable.js";
import { DEFAULT_FIELDS, sanityDataset } from "../lib/sanity.js";
import { makeSanityFor } from "./ship.cli.js";

// Read-only access to CMS posts, in Markdown, so the skill can draft refreshes without
// hand-writing Portable Text. Writes only ever happen through `geo-loop ship`.

export function register(program: Command, ctx: () => Promise<Ctx>) {
  const page = program.command("page").description("read posts from the CMS (read-only)");

  page
    .command("list")
    .description("list published posts: slug and title")
    .option("--test-dataset", "read the test dataset")
    .action(async (o: { testDataset?: boolean }) => {
      const c = await ctx();
      const sanity = makeSanityFor(c.config)(sanityDataset(c.config, !!o.testDataset));
      if (!sanity) throw new Error("no sanity block in config");
      const posts = await sanity.listPosts(c.config.sanity!.postType, DEFAULT_FIELDS);
      if (c.json) console.log(JSON.stringify(posts.map(({ slug, title }) => ({ slug, title })), null, 2));
      else for (const p of posts) console.log(`${p.slug.padEnd(60)} ${p.title}`);
    });

  page
    .command("categories")
    .description("list categories (id, title, post count): a new post needs one as content.categoryRef")
    .option("--type <type>", "category document type", "category")
    .action(async (o: { type: string }) => {
      const c = await ctx();
      const sanity = makeSanityFor(c.config)(sanityDataset(c.config, false));
      if (!sanity?.listTitles) throw new Error("no sanity block in config");
      const rows = await sanity.listTitles(o.type);
      if (c.json) console.log(JSON.stringify(rows, null, 2));
      else for (const r of rows) console.log(`${r.id.padEnd(40)} ${String(r.posts ?? "").padStart(4)} posts  ${r.title}`);
    });

  page
    .command("get <slug>")
    .description("print a post as JSON with its body in Markdown (images kept as ![alt](pt:<key>) placeholders)")
    .option("--test-dataset", "read the test dataset")
    .action(async (slug: string, o: { testDataset?: boolean }) => {
      const c = await ctx();
      const sanity = makeSanityFor(c.config)(sanityDataset(c.config, !!o.testDataset));
      if (!sanity) throw new Error("no sanity block in config");
      const F = DEFAULT_FIELDS;
      const doc = await sanity.getPublishedBySlug(c.config.sanity!.postType, F.slug, slug);
      if (!doc) {
        console.error(`post "${slug}" not found`);
        process.exitCode = 1;
        return;
      }
      const base = c.config.site.baseUrl.replace(/\/$/, "");
      console.log(
        JSON.stringify(
          {
            slug,
            url: `${base}${c.config.site.blogPath}${slug}`,
            title: doc[F.title],
            excerpt: doc[F.excerpt],
            tldr: doc[F.tldr] ?? [],
            publishedAt: doc[F.publishedAt],
            updatedAt: doc._updatedAt,
            bodyMarkdown: ptToMd(doc[F.body]),
          },
          null,
          2,
        ),
      );
    });
}
