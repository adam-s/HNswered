import type { AlgoliaAuthorHit, AlgoliaCommentHit, HNItem, HNUser } from '../../src/shared/types';
import type { HNClient } from '../../src/background/hn-client';
import type { AlgoliaClient } from '../../src/background/algolia-client';

export interface FakeHN extends HNClient, AlgoliaClient {
  seedUser(user: HNUser): void;
  seedItem(item: HNItem): void;
  seedComment(hit: AlgoliaCommentHit): void;
  seedAuthorItem(user: string, hit: AlgoliaAuthorHit): void;
  seedParentChild(parentId: number, hit: AlgoliaCommentHit): void;
  counts(): {
    user: number;
    item: number;
    searchComments: number;
    searchByAuthor: number;
    searchByParent: number;
    total: number;
  };
  log(): string[];
}

export function createFakeHN(): FakeHN {
  const users = new Map<string, HNUser>();
  const items = new Map<number, HNItem>();
  const comments: AlgoliaCommentHit[] = [];
  const authorItems = new Map<string, AlgoliaAuthorHit[]>();
  const parentChildren = new Map<number, AlgoliaCommentHit[]>();
  const requests = { user: 0, item: 0, searchComments: 0, searchByAuthor: 0, searchByParent: 0 };
  const log: string[] = [];

  return {
    seedUser(u) {
      users.set(u.id, structuredClone(u));
    },
    seedItem(i) {
      items.set(i.id, structuredClone(i));
    },
    seedComment(hit) {
      comments.push(structuredClone(hit));
    },
    seedAuthorItem(user, hit) {
      const list = authorItems.get(user) ?? [];
      list.push(structuredClone(hit));
      authorItems.set(user, list);
    },
    seedParentChild(parentId, hit) {
      const list = parentChildren.get(parentId) ?? [];
      list.push(structuredClone(hit));
      parentChildren.set(parentId, list);
    },
    counts() {
      return { ...requests, total: requests.user + requests.item + requests.searchComments + requests.searchByAuthor + requests.searchByParent };
    },
    log() {
      return [...log];
    },
    async user(id) {
      requests.user++;
      log.push(`GET /v0/user/${id}`);
      const u = users.get(id);
      return u ? structuredClone(u) : null;
    },
    async item(id) {
      requests.item++;
      log.push(`GET /v0/item/${id}`);
      const i = items.get(id);
      return i ? structuredClone(i) : null;
    },
    async searchComments(sinceEpochSec) {
      requests.searchComments++;
      log.push(`GET algolia/search_by_date?tags=comment&since=${sinceEpochSec}`);
      return comments
        .filter((h) => h.created_at_i > sinceEpochSec)
        .map((h) => structuredClone(h));
    },
    async searchByAuthor(user, sinceEpochSec) {
      requests.searchByAuthor++;
      log.push(`GET algolia/search_by_date?tags=(story|comment),author_${user}&since=${sinceEpochSec}`);
      const list = authorItems.get(user) ?? [];
      return list
        .filter((h) => h.created_at_i > sinceEpochSec)
        .map((h) => structuredClone(h));
    },
    async searchByParent(parentId, sinceEpochSec) {
      requests.searchByParent++;
      log.push(`GET algolia/search_by_date?parent_id=${parentId}${sinceEpochSec !== undefined ? `&since=${sinceEpochSec}` : ''}`);
      const list = parentChildren.get(parentId) ?? [];
      const filtered = sinceEpochSec !== undefined
        ? list.filter((h) => h.created_at_i > sinceEpochSec)
        : list;
      return filtered.map((h) => structuredClone(h));
    },
  };
}
