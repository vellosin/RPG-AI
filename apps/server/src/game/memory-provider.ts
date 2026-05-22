import neo4j, { type Driver } from "neo4j-driver";
import { config } from "../config.js";
import { buildMemorySearchTerms, retrieveRelevantMemories } from "./campaign-memory.js";
import type { CampaignMemoryEntry, PlayerAction, RoomState } from "./types.js";

const normalize = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const vectorTokens = (value: string): string[] =>
  normalize(value).split(/[^a-z0-9]+/).filter((token) => token.length >= 3);

const hashToken = (token: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index++) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const buildHashedEmbedding = (text: string, dimensions: number): number[] => {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const token of vectorTokens(text)) {
    const hash = hashToken(token);
    const index = hash % dimensions;
    vector[index] += (hash & 1) === 0 ? 1 : -1;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
};

export type CampaignMemoryProvider = {
  retrieveRelevant(room: RoomState, action: PlayerAction, limit?: number): Promise<CampaignMemoryEntry[]>;
  indexRoomMemory?(room: RoomState): Promise<void>;
  getStatus?(): Promise<{ provider: string; enabled: boolean; ok: boolean; details: string }>;
};

export class LocalCampaignMemoryProvider implements CampaignMemoryProvider {
  async retrieveRelevant(room: RoomState, action: PlayerAction, limit = 5): Promise<CampaignMemoryEntry[]> {
    return retrieveRelevantMemories(room, action, limit);
  }

  async getStatus(): Promise<{ provider: string; enabled: boolean; ok: boolean; details: string }> {
    return {
      provider: "local-sqlite-tag-memory",
      enabled: true,
      ok: true,
      details: "Using local campaign memory entries with tag/recency scoring.",
    };
  }
}

class Neo4jCampaignMemoryProvider implements CampaignMemoryProvider {
  private readonly driver: Driver;
  private schemaReady = false;
  private disabledReason = "";

  constructor() {
    this.driver = neo4j.driver(
      config.neo4jUri,
      neo4j.auth.basic(config.neo4jUsername, config.neo4jPassword),
    );
  }

  async retrieveRelevant(room: RoomState, action: PlayerAction, limit = 5): Promise<CampaignMemoryEntry[]> {
    if (this.disabledReason) return [];
    try {
      await this.ensureSchema();
      const vectorMatches = await this.retrieveByVector(room, action, limit);
      if (vectorMatches.length > 0) return vectorMatches;

      const terms = buildMemorySearchTerms(room, action);
      const session = this.driver.session({ database: config.neo4jDatabase });
      try {
        const result = await session.run(
          `
          MATCH (:RpgRoom {id: $roomId})-[:HAS_MEMORY]->(m:CampaignMemory)
          OPTIONAL MATCH (m)-[:TAGGED]->(tag:MemoryTag)
          WITH m, collect(tag.name) AS tags
          WITH m, tags,
               size([term IN $terms WHERE term IN tags OR toLower(m.title) CONTAINS term OR toLower(m.content) CONTAINS term]) AS overlap
          WHERE overlap > 0 OR m.importance >= 6
          RETURN m
          ORDER BY overlap DESC, m.importance DESC, m.updatedAt DESC
          LIMIT $limit
          `,
          { roomId: room.id, terms, limit: neo4j.int(limit) },
        );

        return result.records.map((record) => {
          const props = record.get("m").properties as Record<string, unknown>;
          return {
            id: String(props.id),
            kind: props.kind as CampaignMemoryEntry["kind"],
            title: String(props.title),
            content: String(props.content),
            tags: Array.isArray(props.tags) ? props.tags.map(String) : [],
            importance: Number(props.importance ?? 1),
            createdAt: String(props.createdAt),
            updatedAt: String(props.updatedAt),
            lastReferencedAt: new Date().toISOString(),
          };
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      this.disabledReason = (error as Error).message;
      return [];
    }
  }

  async indexRoomMemory(room: RoomState): Promise<void> {
    if (this.disabledReason) return;
    try {
      await this.ensureSchema();
      const session = this.driver.session({ database: config.neo4jDatabase });
      try {
        await session.executeWrite(async (tx) => {
          await tx.run(
            `
            MERGE (room:RpgRoom {id: $roomId})
            SET room.name = $roomName,
                room.code = $roomCode,
                room.sceneTitle = $sceneTitle,
                room.updatedAt = datetime()
            `,
            {
              roomId: room.id,
              roomName: room.name,
              roomCode: room.code,
              sceneTitle: room.scene.title,
            },
          );

          for (const entry of room.memory.entries) {
            const embedding = buildHashedEmbedding(`${entry.title}\n${entry.content}\n${entry.tags.join(" ")}`, config.neo4jVectorDimensions);
            await tx.run(
              `
              MERGE (memory:CampaignMemory {id: $id})
              SET memory.kind = $kind,
                  memory.title = $title,
                  memory.content = $content,
                  memory.tags = $tags,
                  memory.importance = $importance,
                  memory.createdAt = $createdAt,
                  memory.updatedAt = $updatedAt,
                  memory.embedding = $embedding
              WITH memory
              MATCH (room:RpgRoom {id: $roomId})
              MERGE (room)-[:HAS_MEMORY]->(memory)
              WITH memory
              UNWIND $tags AS tagName
              MERGE (tag:MemoryTag {name: tagName})
              MERGE (memory)-[:TAGGED]->(tag)
              `,
              {
                roomId: room.id,
                id: entry.id,
                kind: entry.kind,
                title: entry.title,
                content: entry.content,
                tags: entry.tags,
                importance: neo4j.int(entry.importance),
                createdAt: entry.createdAt,
                updatedAt: entry.updatedAt,
                embedding,
              },
            );
          }
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      this.disabledReason = (error as Error).message;
    }
  }

  async getStatus(): Promise<{ provider: string; enabled: boolean; ok: boolean; details: string }> {
    if (this.disabledReason) {
      return { provider: "neo4j-graph-memory", enabled: true, ok: false, details: this.disabledReason };
    }
    try {
      await this.ensureSchema();
      const queryApi = config.neo4jHttpQueryUrl ? `; queryApi=${config.neo4jHttpQueryUrl}` : "";
      return { provider: "neo4j-graph-memory", enabled: true, ok: true, details: `${config.neo4jUri}${queryApi}` };
    } catch (error) {
      return { provider: "neo4j-graph-memory", enabled: true, ok: false, details: (error as Error).message };
    }
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    const session = this.driver.session({ database: config.neo4jDatabase });
    try {
      await session.run("CREATE CONSTRAINT rpg_room_id IF NOT EXISTS FOR (room:RpgRoom) REQUIRE room.id IS UNIQUE");
      await session.run("CREATE CONSTRAINT campaign_memory_id IF NOT EXISTS FOR (memory:CampaignMemory) REQUIRE memory.id IS UNIQUE");
      await session.run("CREATE CONSTRAINT memory_tag_name IF NOT EXISTS FOR (tag:MemoryTag) REQUIRE tag.name IS UNIQUE");
      await session.run("CREATE INDEX campaign_memory_kind IF NOT EXISTS FOR (memory:CampaignMemory) ON (memory.kind)");
      try {
        await session.run(
          `
          CREATE VECTOR INDEX campaign_memory_embedding IF NOT EXISTS
          FOR (memory:CampaignMemory) ON (memory.embedding)
          OPTIONS {indexConfig: {
            \`vector.dimensions\`: $dimensions,
            \`vector.similarity_function\`: 'cosine'
          }}
          `,
          { dimensions: neo4j.int(config.neo4jVectorDimensions) },
        );
      } catch {
        // Older Neo4j versions may not support vector indexes. Graph/tag memory still works.
      }
      this.schemaReady = true;
    } finally {
      await session.close();
    }
  }

  private async retrieveByVector(room: RoomState, action: PlayerAction, limit: number): Promise<CampaignMemoryEntry[]> {
    const embedding = buildHashedEmbedding(
      `${action.content}\n${room.scene.title}\n${room.scene.summary}\n${room.scene.activeQuest ?? ""}`,
      config.neo4jVectorDimensions,
    );
    const session = this.driver.session({ database: config.neo4jDatabase });
    try {
      const result = await session.run(
        `
        CALL db.index.vector.queryNodes('campaign_memory_embedding', $limit, $embedding)
        YIELD node, score
        MATCH (:RpgRoom {id: $roomId})-[:HAS_MEMORY]->(node)
        RETURN node AS m, score
        ORDER BY score DESC
        `,
        { roomId: room.id, limit: neo4j.int(limit), embedding },
      );

      return result.records.map((record) => {
        const props = record.get("m").properties as Record<string, unknown>;
        return {
          id: String(props.id),
          kind: props.kind as CampaignMemoryEntry["kind"],
          title: String(props.title),
          content: String(props.content),
          tags: Array.isArray(props.tags) ? props.tags.map(String) : [],
          importance: Number(props.importance ?? 1),
          createdAt: String(props.createdAt),
          updatedAt: String(props.updatedAt),
          lastReferencedAt: new Date().toISOString(),
        };
      });
    } catch {
      return [];
    } finally {
      await session.close();
    }
  }
}

class HybridCampaignMemoryProvider implements CampaignMemoryProvider {
  constructor(
    private readonly localProvider: CampaignMemoryProvider,
    private readonly graphProvider: CampaignMemoryProvider,
  ) {}

  async retrieveRelevant(room: RoomState, action: PlayerAction, limit = 5): Promise<CampaignMemoryEntry[]> {
    const [local, graph] = await Promise.all([
      this.localProvider.retrieveRelevant(room, action, limit),
      this.graphProvider.retrieveRelevant(room, action, limit),
    ]);

    const seen = new Set<string>();
    return [...graph, ...local]
      .filter((entry) => {
        if (seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      })
      .slice(0, limit);
  }

  async indexRoomMemory(room: RoomState): Promise<void> {
    await this.graphProvider.indexRoomMemory?.(room);
  }

  async getStatus(): Promise<{ provider: string; enabled: boolean; ok: boolean; details: string }> {
    return this.graphProvider.getStatus
      ? this.graphProvider.getStatus()
      : this.localProvider.getStatus?.() ?? { provider: "unknown", enabled: false, ok: false, details: "No provider status." };
  }
}

export const createCampaignMemoryProvider = (): CampaignMemoryProvider => {
  const localProvider = new LocalCampaignMemoryProvider();
  if (!config.neo4jEnabled) return localProvider;
  return new HybridCampaignMemoryProvider(localProvider, new Neo4jCampaignMemoryProvider());
};
