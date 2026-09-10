# @nextswitch/cti-sdk

NextSWITCH CTI SDK for enterprise IP PBX / call center management platform integration.

## Installation

```bash
npm install @nextswitch/cti-sdk
```

## Quick Start

```typescript
import { CtiClient, AgentStatus, CtiEventType } from '@nextswitch/cti-sdk';

// Initialize client
const client = new CtiClient({
  baseUrl: 'https://api.nextswitch.io/api/v1/cti',
  wsUrl: 'wss://api.nextswitch.io/api/v1/cti/events',
  token: 'your-jwt-token',
});

// Sign in agent
await client.agent.signIn({
  agentId: 'agent_001',
  skillGroups: ['sales', 'support'],
  initialState: 'ready',
});

// Connect to real-time events
await client.connectEvents();

// Listen for incoming calls
client.events.on(CtiEventType.CallRinging, (event) => {
  console.log('Incoming call:', event.data);
  // Answer the call
  client.call.answer(event.data.callId);
});

// Listen for agent state changes
client.events.on(CtiEventType.AgentStateChanged, (event) => {
  console.log('Agent state changed:', event.data);
});
```

## API Reference

### Agent Management

```typescript
// Sign in
await client.agent.signIn({
  agentId: 'agent_001',
  skillGroups: ['sales'],
  initialState: 'ready',
});

// Sign out
await client.agent.signOut({ reason: 'end of shift' });

// Change state
await client.agent.setReady();
await client.agent.setNotReady('break');
await client.agent.setBreak('lunch', 3600); // 1 hour
await client.agent.setWrapUp();

// Get status
const status = await client.agent.getStatus();
```

### Call Control

```typescript
// Make a call
const call = await client.call.make({
  callee: '13800138000',
  callerId: '02112345678',
});

// Answer a call
await client.call.answer(callId);

// Hang up
await client.call.hangup(callId, { reason: 'customer_request' });

// Hold / Unhold
await client.call.hold(callId);
await client.call.unhold(callId);

// Transfer
await client.call.blindTransfer(callId, '8001'); // Blind transfer
await client.call.consultTransfer(callId, '8002', 'Transferring sales call'); // Consult transfer

// Conference
await client.call.conference(callId, otherCallId);

// Send DTMF
await client.call.sendDtmf(callId, '1234#');
```

### Queue Management

```typescript
// List all queues
const queues = await client.queue.list();

// Get queue details
const detail = await client.queue.get('queue_sales');

// Get agents in queue
const agents = await client.queue.getAgents('queue_sales');

// Get waiting calls
const calls = await client.queue.getCalls('queue_sales');
```

### Event Subscription

```typescript
// Connect to events
await client.connectEvents();

// Subscribe to specific events
const unsubscribe = client.events.on(CtiEventType.CallRinging, (event) => {
  console.log('Call ringing:', event.data);
});

// Subscribe to all events
client.events.onAny((event) => {
  console.log('Event:', event.event, event.data);
});

// Unsubscribe
unsubscribe();

// Disconnect
client.disconnectEvents();
```

## Event Types

### Agent Events
- `agent.signed_in` - Agent signed in
- `agent.signed_out` - Agent signed out
- `agent.state_changed` - Agent state changed

### Call Events
- `call.ringing` - Call is ringing
- `call.answered` - Call answered
- `call.held` - Call put on hold
- `call.unheld` - Call resumed from hold
- `call.transferred` - Call transferred
- `call.conferenced` - Call merged into conference
- `call.terminated` - Call ended

### Queue Events
- `queue.call_queued` - Call entered queue
- `queue.call_dequeued` - Call left queue
- `queue.stats_updated` - Queue statistics updated

## Error Handling

```typescript
import { CtiApiError } from '@nextswitch/cti-sdk';

try {
  await client.call.make({ callee: '13800138000' });
} catch (error) {
  if (error instanceof CtiApiError) {
    console.error(`API Error: ${error.code} - ${error.message}`);
    console.error('Status:', error.statusCode);
    console.error('Details:', error.details);
  }
}
```

## License

MIT
