import { describe, expect, it } from 'vitest';

import type { PineconeHybridHit } from '../../src/retrievers/pinecone.js';
import { RRF_K, fuseReciprocalRank } from '../../src/retrievers/rrf.js';

const mkHit = (id: string, score = 0.5): PineconeHybridHit => ({
    id,
    score,
    publication: 'USPSTF',
    year: 2020,
    section: 'recommendation-summary',
    section_label: 'Recommendation Summary',
    title: id,
    url: '',
    license_tier: 'public_domain',
    chunk_text: `body of ${id}`,
});

describe('fuseReciprocalRank', () => {
    it('single-query input returns the same ordering by RRF score', () => {
        const fused = fuseReciprocalRank({
            perQueryHits: [[mkHit('a'), mkHit('b'), mkHit('c')]],
        });
        expect(fused.map((f) => f.hit.id)).toEqual(['a', 'b', 'c']);
        // 1/(60+1) > 1/(60+2) > 1/(60+3)
        expect(fused[0]!.rrfScore).toBeGreaterThan(fused[1]!.rrfScore);
        expect(fused[1]!.rrfScore).toBeGreaterThan(fused[2]!.rrfScore);
    });

    it('a chunk that appears in multiple queries fuses with summed contributions', () => {
        const fused = fuseReciprocalRank({
            perQueryHits: [
                [mkHit('a'), mkHit('b')],
                [mkHit('b'), mkHit('a')],
            ],
        });
        const a = fused.find((f) => f.hit.id === 'a')!;
        const b = fused.find((f) => f.hit.id === 'b')!;
        // a: rank 1 in q1 + rank 2 in q2 = 1/61 + 1/62
        // b: rank 2 in q1 + rank 1 in q2 = 1/62 + 1/61
        // Identical scores; ties break on first-seen, so 'a' wins.
        expect(a.rrfScore).toBeCloseTo(1 / 61 + 1 / 62);
        expect(b.rrfScore).toBeCloseTo(1 / 61 + 1 / 62);
        expect(fused[0]!.hit.id).toBe('a');
        expect(a.queryCoverage).toBe(2);
        expect(b.queryCoverage).toBe(2);
    });

    it('a middle-of-three chunk that appears in every query can outrank a single-query top-1', () => {
        // 'common' hits rank 2 in q1 and rank 2 in q2 → 2 * 1/62
        // 'aOnly' hits rank 1 in q1 only → 1/61
        // 1/62 + 1/62 ≈ 0.0323 > 1/61 ≈ 0.0164 → common ranks higher.
        const fused = fuseReciprocalRank({
            perQueryHits: [
                [mkHit('aOnly'), mkHit('common')],
                [mkHit('bOnly'), mkHit('common')],
            ],
        });
        expect(fused[0]!.hit.id).toBe('common');
        expect(fused[0]!.queryCoverage).toBe(2);
    });

    it('deduplicates by chunk id — first seen wins for the body', () => {
        const a1 = mkHit('a');
        const a2 = { ...mkHit('a'), chunk_text: 'updated body' };
        const fused = fuseReciprocalRank({
            perQueryHits: [[a1], [a2]],
        });
        expect(fused).toHaveLength(1);
        expect(fused[0]!.hit.chunk_text).toBe('body of a');
    });

    it('respects the topM cap', () => {
        const hits = Array.from({ length: 30 }, (_, i) => mkHit(`h${i}`));
        const fused = fuseReciprocalRank({
            perQueryHits: [hits],
            topM: 5,
        });
        expect(fused).toHaveLength(5);
    });

    it('uses the configured k constant', () => {
        const fused = fuseReciprocalRank({
            perQueryHits: [[mkHit('a')]],
            k: 0,
        });
        expect(fused[0]!.rrfScore).toBe(1);
        // Sanity check on the default constant.
        expect(RRF_K).toBe(60);
    });

    it('handles empty per-query lists', () => {
        const fused = fuseReciprocalRank({ perQueryHits: [[], [mkHit('a')], []] });
        expect(fused).toHaveLength(1);
        expect(fused[0]!.hit.id).toBe('a');
    });

    it('returns an empty array when no queries returned anything', () => {
        const fused = fuseReciprocalRank({ perQueryHits: [[], [], []] });
        expect(fused).toHaveLength(0);
    });
});
