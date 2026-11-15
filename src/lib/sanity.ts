// Thin wrapper over @sanity/client. Everything else talks to the SanityPort interface so tests
// can inject an in-memory fake. Invariant 6: the token is passed to the client and nowhere else;
// errors are re-thrown with the token redacted.

import { createClient, type SanityClient } from "@sanity/client";
import type { Config } from "../config.js";
import { ptToText, redact } from "./gates.js";

export type SanityDoc = { _id: string; _type: string; _rev?: string; [k: string]: unknown };
export type ExistingPost = { id: string; slug: string; title: string; text: string };

/** Field names on the post document. Defaults match Synta's `post` schema. */
export type FieldMap = {
  title: string;
  slug: string;
  body: string;
  excerpt: string; // used as the meta description
  mainImage: string;
  category: string;
  author: string;
  publishedAt: string;
  tldr: string;
  readTime: string;
};

export const DEFAULT_FIELDS: FieldMap = {
  title: "title",
  slug: "slug",
  body: "body",
  excerpt: "excerpt",
  mainImage: "mainImage",
  category: "category",
  author: "author",
  publishedAt: "publishedAt",
  tldr: "tldr",
  readTime: "readTime",
};

export interface SanityPort {
  readonly dataset: string;
  readonly canWrite: boolean;
  getPublishedBySlug(type: string, slugField: string, slug: string): Promise<SanityDoc | null>;
  getDocument(id: string): Promise<SanityDoc | null>;
  listPosts(type: string, f: FieldMap): Promise<ExistingPost[]>;
  latestAuthorRef(type: string, authorField: string): Promise<string | null>;
  createOrReplace(doc: SanityDoc): Promise<void>;
  patchSet(id: string, set: Record<string, unknown>): Promise<void>;
  /** Copy the published doc to `drafts.<id>` and delete the published one (revert of a new post). */
  unpublish(id: string): Promise<void>;
  uploadImage(data: Buffer, filename: string, contentType: string): Promise<{ assetId: string; url: string }>;
}

export class SanityAuthError extends Error {}

export const draftId = (id: string) => (id.startsWith("drafts.") ? id : `drafts.${id}`);
export const publishedId = (id: string) => id.replace(/^drafts\./, "");

export function stripSystemFields(doc: SanityDoc): SanityDoc {
  const { _rev, _createdAt, _updatedAt, _originalId, ...rest } = doc as SanityDoc & Record<string, unknown>;
  void _rev, _createdAt, _updatedAt, _originalId;
  return rest as SanityDoc;
}

export function isAuthError(err: unknown): boolean {
  if (err instanceof SanityAuthError) return true;
  const e = err as { statusCode?: number; response?: { statusCode?: number } };
  const code = e?.statusCode ?? e?.response?.statusCode;
  return code === 401 || code === 403;
}

export function sanityDataset(config: Config, testDataset = false): string {
  if (!config.sanity) throw new Error("config.sanity is not set");
  return testDataset ? config.sanity.testDataset : config.sanity.dataset;
}

export function sanityClient(
  config: Config,
  opts: { dataset: string; token?: string; client?: SanityClient },
): SanityPort {
  if (!config.sanity) throw new Error("config.sanity is not set");
  const token = opts.token;
  const client =
    opts.client ??
    createClient({
      projectId: config.sanity.projectId,
      dataset: opts.dataset,
      apiVersion: config.sanity.apiVersion,
      token,
      useCdn: false,
      // apiVersion >= 2025-02-19 defaults to "published"; we need drafts too.
      perspective: "raw",
    });
  const secrets = token ? [token] : [];

  const wrap = async <T>(op: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      const msg = redact(`sanity ${op}: ${(err as Error)?.message ?? String(err)}`, secrets);
      if (isAuthError(err)) throw new SanityAuthError(`${msg} (auth failed)`);
      throw new Error(msg);
    }
  };
  const needWrite = () => {
    if (!token) throw new SanityAuthError("sanity auth failed: SANITY_WRITE_TOKEN not set");
  };

  return {
    dataset: opts.dataset,
    canWrite: !!token,
    getPublishedBySlug: (type, slugField, slug) =>
      wrap("fetch", () =>
        client.fetch<SanityDoc | null>(
          `*[_type == $type && ${slugField}.current == $slug && !(_id in path("drafts.**"))][0]`,
          { type, slug },
        ),
      ),
    getDocument: (id) => wrap("getDocument", async () => ((await client.getDocument(id)) as SanityDoc | undefined) ?? null),
    listPosts: (type, f) =>
      wrap("listPosts", async () => {
        const rows = await client.fetch<{ _id: string; slug: string; title: string; excerpt?: string; body?: unknown }[]>(
          `*[_type == $type && !(_id in path("drafts.**"))]{_id, "slug": ${f.slug}.current, "title": ${f.title}, "excerpt": ${f.excerpt}, "body": ${f.body}}`,
          { type },
        );
        return rows.map((r) => ({ id: r._id, slug: r.slug, title: r.title ?? "", text: [r.title, r.excerpt, ptToText(r.body)].join("\n") }));
      }),
    latestAuthorRef: (type, authorField) =>
      wrap("latestAuthorRef", () =>
        client.fetch<string | null>(
          `*[_type == $type && defined(${authorField}._ref) && !(_id in path("drafts.**"))] | order(_createdAt desc)[0].${authorField}._ref`,
          { type },
        ),
      ),
    createOrReplace: (doc) =>
      wrap("createOrReplace", async () => {
        needWrite();
        await client.createOrReplace(doc);
      }),
    patchSet: (id, set) =>
      wrap("patch", async () => {
        needWrite();
        await client.patch(id).set(set).commit();
      }),
    unpublish: (id) =>
      wrap("unpublish", async () => {
        needWrite();
        const pub = await client.getDocument(publishedId(id));
        if (!pub) return;
        await client
          .transaction()
          .createOrReplace({ ...stripSystemFields(pub as SanityDoc), _id: draftId(id) })
          .delete(publishedId(id))
          .commit();
      }),
    uploadImage: (data, filename, contentType) =>
      wrap("uploadImage", async () => {
        needWrite();
        const asset = await client.assets.upload("image", data, { filename, contentType });
        return { assetId: asset._id, url: asset.url };
      }),
  };
}
