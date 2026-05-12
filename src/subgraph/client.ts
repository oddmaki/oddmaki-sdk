import { GraphQLClient, type RequestDocument } from 'graphql-request';
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';

export class SubgraphClient {
  private client: GraphQLClient;

  constructor(endpoint: string) {
    this.client = new GraphQLClient(endpoint);
  }

  async request<T>(
    query: RequestDocument | TypedDocumentNode<T, Record<string, unknown>>,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    return this.client.request<T>(query as RequestDocument, variables);
  }
}
