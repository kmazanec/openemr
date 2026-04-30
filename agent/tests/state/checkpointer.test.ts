import { describe, expect, it } from 'vitest';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

import { createCheckpointer } from '../../src/state/checkpointer.js';

describe('createCheckpointer', () => {
    it('returns a PostgresSaver wired to the given connection string', () => {
        const checkpointer = createCheckpointer('postgresql://user:pass@agent-postgres:5432/agent');
        expect(checkpointer).toBeInstanceOf(PostgresSaver);
    });

    it('throws when the connection string is empty', () => {
        expect(() => createCheckpointer('')).toThrow(/connection string/i);
    });
});
