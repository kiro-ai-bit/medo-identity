import {
  createPublisherWorker,
  ensureEventingSchema,
  type Logger,
  type PublisherHandle,
  type Queryable,
} from "@kiro-ai-bit/eventing";

export async function ensureIdentityEventing(deps: {
  service: Queryable;
  broker: Queryable;
}): Promise<void> {
  await ensureEventingSchema({ service: deps.service, broker: deps.broker });
}

export async function startIdentityPublisher(deps: {
  service: Queryable;
  broker: Queryable | string;
  brokerDsn?: string;
  logger?: Logger;
}): Promise<PublisherHandle> {
  return createPublisherWorker({
    source: deps.service,
    broker: deps.brokerDsn ?? deps.broker,
    pollIntervalMs: 5000,
    logger: deps.logger,
  });
}
