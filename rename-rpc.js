import { Rpc } from '@opencode/plugin/rpc';

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };

// Matching contract in the companion notification plugin.
export const RenameRPC = Rpc.define({
  id: 'local-session-rename',
  methods: {
    getState: { input: object({ sessionID: string, executionID: string }), output: object({ sessionID: string, executionID: string, status: string, title: string }) },
  },
  events: {
    state: { schema: object({ sessionID: string, executionID: string, status: string, title: string }) },
  },
});
