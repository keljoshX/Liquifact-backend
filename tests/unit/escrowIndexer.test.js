'use strict';

const {
  normalizeEvent,
  persistEscrowEvent,
  runEscrowIndexerCycle,
  shouldReplaceProjection,
} = require('../../src/jobs/escrowIndexer');

describe('escrowIndexer', () => {
  test('normalizeEvent validates and normalizes payload', () => {
    const event = normalizeEvent({
      eventId: 'evt_1',
      invoiceId: 'inv_123',
      eventType: 'escrow_funded',
      ledgerSequence: 12345,
      pagingToken: '100-1',
      eventBody: { amount: 10 },
    });

    expect(event.invoiceId).toBe('inv_123');
    expect(event.ledgerSequence).toBe(12345);
    expect(event.eventBody).toEqual({ amount: 10 });
  });

  test('normalizeEvent rejects invalid invoice id', () => {
    expect(() =>
      normalizeEvent({
        eventId: 'evt_1',
        invoiceId: 'bad invoice id',
        eventType: 'escrow_funded',
        ledgerSequence: 1,
      })
    ).toThrow('Invalid invoiceId format.');
  });

  test('shouldReplaceProjection uses ledger then paging token ordering', () => {
    const projection = { latest_ledger_sequence: 100, latest_paging_token: '100-1' };
    expect(shouldReplaceProjection(projection, { ledgerSequence: 101, pagingToken: '101-1' })).toBe(true);
    expect(shouldReplaceProjection(projection, { ledgerSequence: 99, pagingToken: '99-9' })).toBe(false);
    expect(shouldReplaceProjection(projection, { ledgerSequence: 100, pagingToken: '100-2' })).toBe(true);
  });

  test('persistEscrowEvent stores event and updates projection when newer', async () => {
    const insertedEvents = [];
    const upsertedProjections = [];
    let projection = null;

    const store = {
      upsertEvent: jest.fn(async (_trx, event) => {
        insertedEvents.push(event);
      }),
      findProjection: jest.fn(async () => projection),
      upsertProjection: jest.fn(async (_trx, event) => {
        upsertedProjections.push(event);
        projection = {
          latest_ledger_sequence: event.ledgerSequence,
          latest_paging_token: event.pagingToken,
        };
      }),
    };

    const transactionRunner = async (handler) => handler({});

    await persistEscrowEvent(
      { store, transactionRunner },
      {
        eventId: 'evt_1',
        invoiceId: 'inv_1',
        eventType: 'escrow_created',
        ledgerSequence: 200,
        pagingToken: '200-1',
      }
    );

    await persistEscrowEvent(
      { store, transactionRunner },
      {
        eventId: 'evt_2',
        invoiceId: 'inv_1',
        eventType: 'escrow_funded',
        ledgerSequence: 201,
        pagingToken: '201-1',
      }
    );

    expect(insertedEvents).toHaveLength(2);
    expect(upsertedProjections).toHaveLength(2);
    expect(upsertedProjections[1].eventId).toBe('evt_2');
  });

  test('runEscrowIndexerCycle processes valid events and advances cursor', async () => {
    const savedCursors = [];
    const store = {
      loadCursor: jest.fn(async () => '100-1'),
      saveCursor: jest.fn(async (cursor) => savedCursors.push(cursor)),
      upsertEvent: jest.fn(async () => {}),
      findProjection: jest.fn(async () => null),
      upsertProjection: jest.fn(async () => {}),
    };

    const summary = await runEscrowIndexerCycle({
      store,
      transactionRunner: async (handler) => handler({}),
      fetchEscrowEvents: async () => ({
        events: [
          {
            eventId: 'evt_1',
            invoiceId: 'inv_10',
            eventType: 'escrow_created',
            ledgerSequence: 101,
            pagingToken: '101-1',
          },
          {
            eventId: 'evt_2',
            invoiceId: 'bad invoice',
            eventType: 'escrow_funded',
            ledgerSequence: 101,
            pagingToken: '101-2',
          },
        ],
        nextCursor: '101-2',
      }),
      log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
    });

    expect(summary.processed).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(savedCursors).toEqual(['101-2']);
  });
});
