import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  ensureDir,
  loadSqliteVecExtension,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { ChunkHit, IndexIdentity } from "./types.js";

// A single unstructured row (id always 1) holding the index's identity
// fingerprint. Compared against the caller's current config on open --
// see checkIdentityDrift equivalent in handle.ts.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS semantic_index_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  chunk_tokens INTEGER NOT NULL,
  chunk_overlap INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS semantic_notes (
  note_id TEXT PRIMARY KEY,
  blob_id TEXT NOT NULL,
  utc_date_modified TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS semantic_chunks (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  text TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS semantic_chunks_note_id ON semantic_chunks(note_id);

CREATE TABLE IF NOT EXISTS semantic_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  watermark TEXT,
  updated_at TEXT NOT NULL
);
`;

const VEC_TABLE = "semantic_chunks_vec";

function assertValidDimensions(dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`semantic search: invalid embedding dimensions (${dimensions})`);
  }
}

export type OpenStoreResult =
  | { available: true; store: SemanticIndexStore }
  | { available: false; reason: string };

export type UpsertChunk = {
  id: string;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
  embedding: number[];
};

// Owns the plugin's private SQLite file: schema, identity/drift detection,
// per-note chunk+vector storage, sync watermark, and the brute-force
// cosine KNN query. Vector-only (no FTS5/BM25 leg) -- Trilium's own
// search already supplies the lexical leg one level up, in the same
// trilium_search_notes call (see mergeSemanticMatches in
// src/tools/notes.ts). Architecture mirrors
// @transmitt0r/openclaw-plugin-paperless-ngx's src/semantic/store.ts;
// the notable difference is the primary key: Trilium noteIds are opaque
// strings (EntityId, `[a-zA-Z0-9_]{4,32}`), not paperless's integer
// document ids, and `blob_id` (Trilium's own content-hash field, free on
// every Note object) replaces a locally-computed content hash entirely --
// see sync.ts for why that's strictly cheaper than paperless-ngx's
// fetch-then-hash approach.
export class SemanticIndexStore {
  private constructor(private readonly db: DatabaseSyncType) {}

  // Feature-detects node:sqlite (absent on Node 20, this plugin's declared
  // floor) and the sqlite-vec extension, then opens/creates the index file
  // and its schema. Never throws -- any failure resolves to
  // `{ available: false, reason }` so the caller can fail open to
  // lexical-only search instead of crashing plugin registration.
  static async open(indexPath: string, dimensions: number): Promise<OpenStoreResult> {
    let sqlite: typeof import("node:sqlite");
    try {
      sqlite = requireNodeSqlite();
    } catch (err) {
      return { available: false, reason: describeError(err) };
    }

    let db: DatabaseSyncType | undefined;
    try {
      assertValidDimensions(dimensions);
      if (indexPath !== ":memory:") {
        ensureDir(path.dirname(indexPath));
      }
      db = new sqlite.DatabaseSync(indexPath, { allowExtension: true });
      const vecResult = await loadSqliteVecExtension({ db });
      if (!vecResult.ok) {
        db.close();
        return {
          available: false,
          reason: vecResult.error ?? "sqlite-vec extension failed to load",
        };
      }
      const store = new SemanticIndexStore(db);
      store.ensureSchema(dimensions);
      return { available: true, store };
    } catch (err) {
      try {
        db?.close();
      } catch {
        // ignore -- don't let close-time cleanup mask the original error
      }
      return { available: false, reason: describeError(err) };
    }
  }

  private ensureSchema(dimensions: number): void {
    this.db.exec(SCHEMA_SQL);
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[${dimensions}])`,
    );
  }

  getIdentity(): IndexIdentity | undefined {
    const row = this.db
      .prepare(
        "SELECT provider_id, model, dimensions, chunk_tokens, chunk_overlap FROM semantic_index_meta WHERE id = 1",
      )
      .get() as
      | {
          provider_id: string;
          model: string;
          dimensions: number;
          chunk_tokens: number;
          chunk_overlap: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      providerId: row.provider_id,
      model: row.model,
      dimensions: row.dimensions,
      chunkTokens: row.chunk_tokens,
      chunkOverlap: row.chunk_overlap,
    };
  }

  private setIdentity(identity: IndexIdentity): void {
    this.db
      .prepare(
        `INSERT INTO semantic_index_meta (id, provider_id, model, dimensions, chunk_tokens, chunk_overlap)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider_id = excluded.provider_id,
           model = excluded.model,
           dimensions = excluded.dimensions,
           chunk_tokens = excluded.chunk_tokens,
           chunk_overlap = excluded.chunk_overlap`,
      )
      .run(
        identity.providerId,
        identity.model,
        identity.dimensions,
        identity.chunkTokens,
        identity.chunkOverlap,
      );
  }

  // Wipes every note/chunk/vector and the sync watermark, then records
  // `identity` as the new fingerprint. Called when the stored identity
  // doesn't match the configured provider/model/dims/chunking -- mixing
  // vectors from two different models in one vec0 table would make KNN
  // distances meaningless, so a clean rebuild (full re-backfill from
  // Trilium, since the index is fully derivable from note content) is the
  // only safe option.
  rebuild(identity: IndexIdentity): void {
    assertValidDimensions(identity.dimensions);
    this.db.exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`);
    this.db.exec("DELETE FROM semantic_chunks");
    this.db.exec("DELETE FROM semantic_notes");
    this.db.exec("DELETE FROM semantic_sync_state");
    this.ensureSchema(identity.dimensions);
    this.setIdentity(identity);
  }

  getNoteBlobId(noteId: string): string | undefined {
    const row = this.db
      .prepare("SELECT blob_id FROM semantic_notes WHERE note_id = ?")
      .get(noteId) as { blob_id: string } | undefined;
    return row?.blob_id;
  }

  // Replaces every chunk/vector belonging to `noteId` with `chunks`
  // (paired 1:1 with `chunks[i].embedding`) in one transaction, and
  // records the note's blobId/utcDateModified so a future sync pass can
  // short-circuit purely from the cheap search-result fields, without
  // ever fetching this note's content again unless blobId actually
  // changes.
  upsertNote(noteId: string, blobId: string, utcDateModified: string, chunks: UpsertChunk[]): void {
    const now = new Date().toISOString();
    this.withTransaction(() => {
      this.deleteNoteChunks(noteId);
      const insertChunk = this.db.prepare(
        "INSERT INTO semantic_chunks (id, note_id, start_line, end_line, text, hash) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const insertVec = this.db.prepare(`INSERT INTO ${VEC_TABLE} (id, embedding) VALUES (?, ?)`);
      for (const chunk of chunks) {
        insertChunk.run(chunk.id, noteId, chunk.startLine, chunk.endLine, chunk.text, chunk.hash);
        insertVec.run(chunk.id, JSON.stringify(chunk.embedding));
      }
      this.db
        .prepare(
          `INSERT INTO semantic_notes (note_id, blob_id, utc_date_modified, indexed_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(note_id) DO UPDATE SET
             blob_id = excluded.blob_id,
             utc_date_modified = excluded.utc_date_modified,
             indexed_at = excluded.indexed_at`,
        )
        .run(noteId, blobId, utcDateModified, now);
    });
  }

  // Removes a note Trilium no longer has (deleted, or moved out of
  // whatever filter scope this plugin indexes) from the index entirely.
  deleteNote(noteId: string): void {
    this.withTransaction(() => {
      this.deleteNoteChunks(noteId);
      this.db.prepare("DELETE FROM semantic_notes WHERE note_id = ?").run(noteId);
    });
  }

  private deleteNoteChunks(noteId: string): void {
    const ids = this.db.prepare("SELECT id FROM semantic_chunks WHERE note_id = ?").all(noteId) as {
      id: string;
    }[];
    if (ids.length === 0) return;
    const deleteVec = this.db.prepare(`DELETE FROM ${VEC_TABLE} WHERE id = ?`);
    for (const { id } of ids) deleteVec.run(id);
    this.db.prepare("DELETE FROM semantic_chunks WHERE note_id = ?").run(noteId);
  }

  getSyncWatermark(): string | undefined {
    const row = this.db.prepare("SELECT watermark FROM semantic_sync_state WHERE id = 1").get() as
      | { watermark: string | null }
      | undefined;
    return row?.watermark ?? undefined;
  }

  setSyncWatermark(watermark: string | undefined): void {
    this.db
      .prepare(
        `INSERT INTO semantic_sync_state (id, watermark, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET watermark = excluded.watermark, updated_at = excluded.updated_at`,
      )
      .run(watermark ?? null, new Date().toISOString());
  }

  // Brute-force cosine KNN over every stored chunk vector via sqlite-vec's
  // vec_distance_cosine scalar function. At the scale this is tuned for
  // (a personal vault, low thousands of notes / tens of thousands of
  // chunks), a full scan is a few milliseconds -- same reasoning and
  // measurement basis as paperless-ngx's identically named method.
  knnSearch(queryEmbedding: number[], limit: number): ChunkHit[] {
    const rows = this.db
      .prepare(
        `SELECT c.id AS chunk_id, c.note_id AS note_id, c.start_line AS start_line,
                c.end_line AS end_line, c.text AS text,
                vec_distance_cosine(v.embedding, vec_f32(?)) AS dist
           FROM ${VEC_TABLE} v
           JOIN semantic_chunks c ON c.id = v.id
          ORDER BY dist ASC
          LIMIT ?`,
      )
      .all(JSON.stringify(queryEmbedding), limit) as {
      chunk_id: string;
      note_id: string;
      start_line: number;
      end_line: number;
      text: string;
      dist: number;
    }[];
    return rows.map((row) => ({
      chunkId: row.chunk_id,
      noteId: row.note_id,
      startLine: row.start_line,
      endLine: row.end_line,
      text: row.text,
      score: 1 - row.dist,
    }));
  }

  noteCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM semantic_notes").get() as { n: number };
    return row.n;
  }

  private withTransaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
