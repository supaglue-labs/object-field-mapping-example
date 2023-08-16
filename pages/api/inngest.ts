import { Inngest } from "inngest";
import { serve } from "inngest/next";
import prisma from "../../lib/prisma";

type BaseSyncComplete = {
  webhook_event_type: string;
  run_id: string;
  connection_id: string;
  customer_id: string;
  provider_name: string;
  result: "SUCCESS" | "ERROR";
  num_records_synced?: number;
  error_message?: string;
};

type ObjectSyncComplete = BaseSyncComplete & {
  type: "object";
  object_type: "common" | "standard";
  object: string;
};

type EntitySyncComplete = BaseSyncComplete & {
  type: "entity";
  entity_id: string;
  entity_name: string;
};

type SyncComplete = ObjectSyncComplete | EntitySyncComplete;

// Create a client to send and receive events
export const inngest = new Inngest({ name: "My App" });

const helloWorld = inngest.createFunction(
  { name: "Transformed data from Supaglue" },
  { event: "supaglue/sync.completed" },
  async ({ event, step }) => {
    console.log("we got the event", JSON.stringify(event, null, 2));
    // Treat as SyncComplete event
    const data = event.data as SyncComplete;

    if (
      !(
        data.type === "object" &&
        data.object_type === "standard" &&
        data.object === "deal"
      )
    ) {
      return { event, body: "Not a deal sync" };
    }

    // Find high watermark for this sync
    const lastMaxLastModifiedAt = await step.run(
      "Get high watermark",
      async () => {
        const state = await prisma.syncState.findUnique({
          where: {
            type_objectType_object: {
              type: data.type,
              objectType: data.object_type,
              object: data.object,
            },
          },
        });

        return state?.maxLastModifiedAt?.getTime();
      }
    );

    // Poll records from table, transform, and write to our own table
    // TODO: Don't iterate one by one
    const newMaxLastModifiedAtMs = await step.run(
      "Transform and copy data",
      async () => {
        // TODO: we should only be looking at the rows for a particular provider / customer
        const supaglueDeals = await prisma.supaglueHubSpotDeal.findMany({
          where: {
            supaglue_last_modified_at: {
              gt: lastMaxLastModifiedAt
                ? new Date(lastMaxLastModifiedAt)
                : undefined,
            },
          },
        });

        console.log("we got deals", supaglueDeals.length);

        if (!supaglueDeals.length) {
          return undefined;
        }

        let maxLastModifiedAtMs = 0;

        for (const supaglueDeal of supaglueDeals) {
          const lastModifiedAtMs =
            supaglueDeal.supaglue_last_modified_at.getTime();
          maxLastModifiedAtMs = Math.max(maxLastModifiedAtMs, lastModifiedAtMs);

          if (supaglueDeal.supaglue_is_deleted) {
            await prisma.opportunity.delete({
              where: {
                providerName_customerId_originalId: {
                  providerName: supaglueDeal.supaglue_provider_name,
                  customerId: supaglueDeal.supaglue_customer_id,
                  originalId: supaglueDeal.supaglue_id,
                },
              },
            });
          } else {
            const mappedData = supaglueDeal.supaglue_mapped_data as Record<
              string,
              any
            >;
            const data = {
              providerName: supaglueDeal.supaglue_provider_name,
              customerId: supaglueDeal.supaglue_customer_id,
              originalId: supaglueDeal.supaglue_id,
              name: mappedData.dealname,
              amount: mappedData.amount ? parseInt(mappedData.amount) : null,
              lastModifiedAt: supaglueDeal.supaglue_last_modified_at,
            };

            await prisma.opportunity.upsert({
              create: data,
              update: data,
              where: {
                providerName_customerId_originalId: {
                  providerName: supaglueDeal.supaglue_provider_name,
                  customerId: supaglueDeal.supaglue_customer_id,
                  originalId: supaglueDeal.supaglue_id,
                },
              },
            });
          }
        }

        return maxLastModifiedAtMs;
      }
    );

    // record the high watermark seen
    if (newMaxLastModifiedAtMs) {
      await step.run("Record high watermark", async () => {
        console.log("new max last modified at", newMaxLastModifiedAtMs);

        const state = {
          type: data.type,
          objectType: data.object_type,
          object: data.object,
          entityId: null,
          maxLastModifiedAt: newMaxLastModifiedAtMs
            ? new Date(newMaxLastModifiedAtMs)
            : undefined,
        };
        await prisma.syncState.upsert({
          create: state,
          update: state,
          where: {
            type_objectType_object: {
              type: data.type,
              objectType: data.object_type,
              object: data.object,
            },
          },
        });
      });
    }

    return {
      event,
      body: "Successfully copied updated deals from staging table",
    };
  }
);

// Create an API that serves zero functions
export default serve(inngest, [helloWorld]);
