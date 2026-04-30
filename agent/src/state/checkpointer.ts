import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

export const createCheckpointer = (connString: string): PostgresSaver => {
    if (connString.trim().length === 0) {
        throw new Error('Postgres connection string is required to build a checkpointer');
    }
    return PostgresSaver.fromConnString(connString);
};
