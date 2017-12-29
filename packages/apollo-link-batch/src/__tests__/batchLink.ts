import {
  ApolloLink,
  execute,
  Observable,
  Operation,
  FetchResult,
  createOperation,
} from 'apollo-link';
import gql from 'graphql-tag';
import { print } from 'graphql/language/printer';

import {
  BatchLink,
  OperationBatcher,
  BatchHandler,
  BatchableRequest,
} from '../batchLink';

interface MockedResponse {
  request: Operation;
  result?: FetchResult;
  error?: Error;
  delay?: number;
}

function requestToKey(request: Operation): string {
  const queryString =
    typeof request.query === 'string' ? request.query : print(request.query);

  return JSON.stringify({
    variables: request.variables || {},
    query: queryString,
  });
}

function createMockBatchHandler(...mockedResponses: MockedResponse[]) {
  const mockedResponsesByKey: { [key: string]: MockedResponse[] } = {};

  const mockBatchHandler: BatchHandler = (operations: Operation[]) => {
    return new Observable(observer => {
      const results = operations.map(operation => {
        const key = requestToKey(operation);
        const responses = mockedResponsesByKey[key];
        if (!responses || responses.length === 0) {
          throw new Error(
            `No more mocked responses for the query: ${print(
              operation.query,
            )}, variables: ${JSON.stringify(operation.variables)}`,
          );
        }

        const { result, error } = responses.shift()!;

        if (!result && !error) {
          throw new Error(
            `Mocked response should contain either result or error: ${key}`,
          );
        }

        if (error) {
          observer.error(error);
        }

        return result;
      });

      observer.next(results);
    });
  };

  (mockBatchHandler as any).addMockedResponse = (
    mockedResponse: MockedResponse,
  ) => {
    const key = requestToKey(mockedResponse.request);
    let _mockedResponses = mockedResponsesByKey[key];
    if (!_mockedResponses) {
      _mockedResponses = [];
      mockedResponsesByKey[key] = _mockedResponses;
    }
    _mockedResponses.push(mockedResponse);
  };

  mockedResponses.map((mockBatchHandler as any).addMockedResponse);

  return mockBatchHandler;
}

describe('OperationBatcher', () => {
  it('should construct', () => {
    expect(() => {
      const querySched = new OperationBatcher({
        batchInterval: 10,
        batchHandler: () => null,
      });
      querySched.consumeQueue();
    }).not.toThrow();
  });

  it('should not do anything when faced with an empty queue', () => {
    const batcher = new OperationBatcher({
      batchInterval: 10,
      batchHandler: () => {
        return null;
      },
    });

    expect(batcher.queuedRequests.length).toBe(0);
    batcher.consumeQueue();
    expect(batcher.queuedRequests.length).toBe(0);
  });

  it('should be able to add to the queue', () => {
    const batcher = new OperationBatcher({
      batchInterval: 10,
      batchHandler: () => {
        return null;
      },
    });

    const query = gql`
      query {
        author {
          firstName
          lastName
        }
      }
    `;

    const request: BatchableRequest = {
      operation: { query },
    };

    expect(batcher.queuedRequests.length).toBe(0);
    batcher.enqueueRequest(request).subscribe({});
    expect(batcher.queuedRequests.length).toBe(1);
    batcher.enqueueRequest(request).subscribe({});
    expect(batcher.queuedRequests.length).toBe(2);
  });

  describe('request queue', () => {
    const query = gql`
      query {
        author {
          firstName
          lastName
        }
      }
    `;
    const data = {
      author: {
        firstName: 'John',
        lastName: 'Smith',
      },
    };
    const batchHandler = createMockBatchHandler(
      {
        request: { query },
        result: { data },
      },
      {
        request: { query },
        result: { data },
      },
    );
    const operation: Operation = createOperation(
      {},
      {
        query,
      },
    );

    it('should be able to consume from a queue containing a single query', done => {
      const myBatcher = new OperationBatcher({
        batchInterval: 10,
        batchHandler,
      });

      myBatcher.enqueueRequest({ operation }).subscribe(resultObj => {
        expect(myBatcher.queuedRequests.length).toBe(0);
        expect(resultObj).toEqual({ data });
        done();
      });
      const observables: (
        | Observable<FetchResult>
        | undefined)[] = myBatcher.consumeQueue()!;

      expect(observables.length).toBe(1);
    });

    it('should be able to consume from a queue containing multiple queries', done => {
      const request2: Operation = createOperation(
        {},
        {
          query,
        },
      );

      const BH = createMockBatchHandler(
        {
          request: { query },
          result: { data },
        },
        {
          request: { query },
          result: { data },
        },
      );

      const myBatcher = new OperationBatcher({
        batchInterval: 10,
        batchMax: 10,
        batchHandler: BH,
      });
      const observable1 = myBatcher.enqueueRequest({ operation });
      const observable2 = myBatcher.enqueueRequest({ operation: request2 });
      let notify = false;
      observable1.subscribe(resultObj1 => {
        expect(resultObj1).toEqual({ data });

        if (notify) {
          done();
        } else {
          notify = true;
        }
      });

      observable2.subscribe(resultObj2 => {
        expect(resultObj2).toEqual({ data });

        if (notify) {
          done();
        } else {
          notify = true;
        }
      });

      expect(myBatcher.queuedRequests.length).toBe(2);
      const observables: (
        | Observable<FetchResult>
        | undefined)[] = myBatcher.consumeQueue()!;
      expect(myBatcher.queuedRequests.length).toBe(0);
      expect(observables.length).toBe(2);
    });

    it('should return a promise when we enqueue a request and resolve it with a result', done => {
      const BH = createMockBatchHandler({
        request: { query },
        result: { data },
      });
      const myBatcher = new OperationBatcher({
        batchInterval: 10,
        batchHandler: BH,
      });
      const observable = myBatcher.enqueueRequest({ operation });
      observable.subscribe(result => {
        expect(result).toEqual({ data });
        done();
      });
      myBatcher.consumeQueue();
    });
  });

  it('should work when single query', done => {
    const data = {
      lastName: 'Ever',
      firstName: 'Greatest',
    };
    const batcher = new OperationBatcher({
      batchInterval: 10,
      batchHandler: () =>
        new Observable(observer => {
          observer.next([{ data }]);
          setTimeout(observer.complete.bind(observer));
        }),
    });
    const query = gql`
      query {
        author {
          firstName
          lastName
        }
      }
    `;
    const operation: Operation = createOperation({}, { query });

    batcher.enqueueRequest({ operation }).subscribe({});
    expect(batcher.queuedRequests.length).toBe(1);

    setTimeout(() => {
      expect(batcher.queuedRequests.length).toBe(0);
      expect(operation.getContext()).toEqual({ response: { data } });
      done();
    }, 20);
  });

  it('should correctly batch multiple queries', done => {
    const data = {
      lastName: 'Ever',
      firstName: 'Greatest',
    };
    const data2 = {
      lastName: 'Hauser',
      firstName: 'Evans',
    };
    const batcher = new OperationBatcher({
      batchInterval: 10,
      batchHandler: () =>
        new Observable(observer => {
          observer.next([{ data }, { data: data2 }, { data }]);
          setTimeout(observer.complete.bind(observer));
        }),
    });
    const query = gql`
      query {
        author {
          firstName
          lastName
        }
      }
    `;
    const operation: Operation = createOperation({}, { query });
    const operation2: Operation = createOperation({}, { query });
    const operation3: Operation = createOperation({}, { query });

    batcher.enqueueRequest({ operation }).subscribe({});
    batcher.enqueueRequest({ operation: operation2 }).subscribe({});
    expect(batcher.queuedRequests.length).toBe(2);

    setTimeout(() => {
      // The batch shouldn't be fired yet, so we can add one more request.
      batcher.enqueueRequest({ operation: operation3 }).subscribe({});
      expect(batcher.queuedRequests.length).toBe(3);
    }, 5);

    setTimeout(() => {
      // The batch should've been fired by now.
      expect(operation.getContext()).toEqual({ response: { data } });
      expect(operation2.getContext()).toEqual({ response: { data: data2 } });
      expect(operation3.getContext()).toEqual({ response: { data } });
      expect(batcher.queuedRequests.length).toBe(0);
      done();
    }, 20);
  });

  it('should reject the promise if there is a network error', done => {
    const query = gql`
      query {
        author {
          firstName
          lastName
        }
      }
    `;
    const operation: Operation = createOperation({}, { query });
    const error = new Error('Network error');
    const BH = createMockBatchHandler({
      request: { query },
      error,
    });
    const batcher = new OperationBatcher({
      batchInterval: 10,
      batchHandler: BH,
    });

    const observable = batcher.enqueueRequest({ operation });
    observable.subscribe({
      error: (resError: Error) => {
        expect(resError.message).toBe('Network error');
        done();
      },
    });
    batcher.consumeQueue();
  });
});

describe('BatchLink', () => {
  it('does not need any constructor arguments', () => {
    expect(
      () => new BatchLink({ batchHandler: () => Observable.of() }),
    ).not.toThrow();
  });

  it('passes forward on', done => {
    const query = gql`
      {
        id
      }
    `;
    const link = ApolloLink.from([
      new BatchLink({
        batchInterval: 0,
        batchMax: 1,
        batchHandler: (operation, forward) => {
          expect(forward.length).toBe(1);
          expect(operation.length).toBe(1);
          return forward[0](operation[0]);
        },
      }),
      new ApolloLink(operation => {
        expect(operation.query).toEqual(query);
        done();
      }),
    ]);

    execute(
      link,
      createOperation(
        {},
        {
          query,
        },
      ),
    ).subscribe();
  });

  it('raises warning if terminating', () => {
    let calls = 0;
    const link_full = new BatchLink({
      batchHandler: (operation, forward) => forward(operation),
    });
    const link_one_op = new BatchLink({
      batchHandler: operation => Observable.of(),
    });
    const link_no_op = new BatchLink({ batchHandler: () => Observable.of() });
    const _warn = console.warn;
    console.warn = warning => {
      calls++;
      expect(warning['message']).toBeDefined();
    };
    expect(
      link_one_op.concat((operation, forward) => forward(operation)),
    ).toEqual(link_one_op);
    expect(
      link_no_op.concat((operation, forward) => forward(operation)),
    ).toEqual(link_no_op);
    console.warn = warning => {
      throw Error('non-terminating link should not throw');
    };
    expect(
      link_full.concat((operation, forward) => forward(operation)),
    ).not.toEqual(link_full);
    console.warn = _warn;
    expect(calls).toBe(2);
  });

  it('correctly uses batch size', done => {
    const sizes = [1, 2, 3];
    const terminating = new ApolloLink(operation => {
      expect(operation.query).toEqual(query);
      return Observable.of(operation.variables.count);
    });

    const query = gql`
      {
        id
      }
    `;

    let runBatchSize = () => {
      const size = sizes.pop();
      if (!size) done();

      const batchHandler = jest.fn((operation, forward) => {
        expect(operation.length).toBe(size);
        expect(forward.length).toBe(size);
        const observables = forward.map((f, i) => f(operation[i]));
        return new Observable(observer => {
          const data = [];
          observables.forEach(obs =>
            obs.subscribe(d => {
              data.push(d);
              if (data.length === observables.length) {
                observer.next(data);
                observer.complete();
              }
            }),
          );
        });
      });

      const link = ApolloLink.from([
        new BatchLink({
          batchInterval: 1000,
          batchMax: size,
          batchHandler,
        }),
        terminating,
      ]);

      Array.from(new Array(size)).forEach((_, i) => {
        execute(link, {
          query,
          variables: { count: i },
        }).subscribe({
          next: data => {
            expect(data).toBe(i);
          },
          complete: () => {
            expect(batchHandler.mock.calls.length).toBe(1);
            runBatchSize();
          },
        });
      });
    };

    runBatchSize();
  });

  it('correctly follows batch interval', done => {
    const intervals = [10, 20, 30];
    const query = gql`
      {
        id
      }
    `;

    const runBatchInterval = () => {
      const mock = jest.fn();

      const batchInterval = intervals.pop();
      if (!batchInterval) done();

      const batchHandler = jest.fn((operation, forward) => {
        expect(operation.length).toBe(1);
        expect(forward.length).toBe(1);
        return forward[0](operation[0]).map(d => [d]);
      });

      const link = ApolloLink.from([
        new BatchLink({
          batchInterval,
          batchMax: 0,
          batchHandler,
        }),
        () => Observable.of(42),
      ]);

      execute(
        link,
        createOperation(
          {},
          {
            query,
          },
        ),
      ).subscribe({
        next: data => {
          expect(data).toBe(42);
        },
        complete: () => {
          mock(batchHandler.mock.calls.length);
        },
      });

      setTimeout(() => {
        const checkCalls = mock.mock.calls.slice(0, -1);
        expect(checkCalls.length).toBe(2);
        checkCalls.forEach(args => expect(args[0]).toBe(0));
        expect(mock).lastCalledWith(1);
        expect(batchHandler.mock.calls.length).toBe(1);

        runBatchInterval();
      }, batchInterval + 1);

      setTimeout(() => mock(batchHandler.mock.calls.length), batchInterval - 1);
      setTimeout(() => mock(batchHandler.mock.calls.length), batchInterval / 2);
    };
    runBatchInterval();
  });
});
