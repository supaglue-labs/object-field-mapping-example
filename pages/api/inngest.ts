import { Inngest } from "inngest";
import { serve } from "inngest/next";
import { getMapper } from "../../lib/mappers";
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

/**
 * Our app has 2 different "Entities":
 * 1. Contact -> This could map to HubSpot contact, Salesforce contact, or Salesforce lead.
 * 2. Opportunity -> This could map to HubSpot deal or Salesforce opportunity.
 *    We also need to have a "probability" field on this entity.
 */
const transformedSyncedData = inngest.createFunction(
  { name: "Transform data from Supaglue" },
  { event: "supaglue/sync.complete" },
  async ({ event, step }) => {
    // TODO: need to have something in place to make sure that at most
    // one of these handlers is running at a time for a given provider/customer/object

    // Treat as SyncComplete event
    const data = event.data as SyncComplete;

    if (!(data.type === "object" && data.object_type === "standard")) {
      return { event, body: "Not a standard object sync" };
    }

    if (data.result !== "SUCCESS") {
      return { event, body: "Sync failed" };
    }

    // For different customers, we want to map things differently
    const mapper = getMapper(data.provider_name, data.customer_id, data.object);
    if (!mapper) {
      return {
        event,
        body: "No mapper found for this provider/customer/object, so no action was taken.",
      };
    }

    // Find high watermark for this sync
    const lastMaxLastModifiedAtMs = await step.run(
      "Get high watermark",
      async () => {
        const state = await prisma.syncState.findUnique({
          where: {
            providerName_customerId_object: {
              providerName: data.provider_name,
              customerId: data.customer_id,
              object: data.object,
            },
          },
        });

        return state?.maxLastModifiedAt?.getTime();
      }
    );

    const lastMaxModifiedAt = lastMaxLastModifiedAtMs
      ? new Date(lastMaxLastModifiedAtMs)
      : undefined;

    const newMaxLastModifiedAtMs = await step.run("Update records", async () => {
      async function getSupaglueRecords(providerName: string, object: string) {
        const params = {
          where: {
            supaglue_provider_name: data.provider_name,
            supaglue_customer_id: data.customer_id,
            supaglue_last_modified_at: {
              gt: lastMaxModifiedAt,
            },
          },
        };

        switch (providerName) {
          case "salesforce": {
            switch (object) {
              case "Contact":
                return prisma.supaglueSalesforceContact.findMany(params);
              case "Lead":
                return prisma.supaglueSalesforceLead.findMany(params);
              case "Opportunity":
                return prisma.supaglueSalesforceOpportunity.findMany(params);
              default:
                throw new Error(`Unsupported Salesforce object: ${object}`);
            }
          }
          case "hubspot": {
            switch (object) {
              case "contact":
                return prisma.supaglueHubSpotContact.findMany(params);
              case "deal":
                return prisma.supaglueHubSpotDeal.findMany(params);
              default:
                throw new Error(`Unsupported HubSpot object: ${object}`);
            }
          }
          default:
            throw new Error(`Unsupported provider: ${providerName}`);
        }
      }

      // Read from staging table
      const records = await getSupaglueRecords(data.provider_name, data.object);
      if (!records.length) {
        return undefined;
      }

      let maxLastModifiedAtMs = 0;

      // TODO: don't iterate one by one
      for (const record of records) {
        const lastModifiedAtMs = record.supaglue_last_modified_at.getTime();
        if (lastModifiedAtMs > maxLastModifiedAtMs) {
          maxLastModifiedAtMs = lastModifiedAtMs;
        }

        if (record.supaglue_is_deleted) {
          // Delete
          const params = {
            where: {
              providerName: data.provider_name,
              customerId: data.customer_id,
              originalId: record.supaglue_id,
            },
          }
  
          switch (mapper.entityName) {
            case 'contact':
              await prisma.contact.deleteMany(params);
            case 'opportunity':
              await prisma.opportunity.deleteMany(params);
          }
        } else {
          // Upsert
          switch (mapper.entityName) {
            case 'contact': {
              const mappedRecord = mapper.mappingFn(record);
              const decoratedData = {
                providerName: data.provider_name,
                customerId: data.customer_id,
                originalId: record.supaglue_id,
                ...mappedRecord,
              };
              await prisma.contact.upsert({
                create: decoratedData,
                update: decoratedData,
                where: {
                  providerName_customerId_originalId: {
                    providerName: data.provider_name,
                    customerId: data.customer_id,
                    originalId: record.supaglue_id,
                  }
                }
              })
            }
            case 'opportunity': {
              const mappedRecord = mapper.mappingFn(record);
              const decoratedData = {
                providerName: data.provider_name,
                customerId: data.customer_id,
                originalId: record.supaglue_id,
                ...mappedRecord,
              };
              await prisma.opportunity.upsert({
                create: decoratedData,
                update: decoratedData,
                where: {
                  providerName_customerId_originalId: {
                    providerName: data.provider_name,
                    customerId: data.customer_id,
                    originalId: record.supaglue_id,
                  }
                }
              })
            }
          }
        }

        return maxLastModifiedAtMs;
      }
    });

    // record the high watermark seen
    if (newMaxLastModifiedAtMs) {
      await step.run("Record high watermark", async () => {
        const state = {
          providerName: data.provider_name,
          customerId: data.customer_id,
          object: data.object,
          maxLastModifiedAt: newMaxLastModifiedAtMs
            ? new Date(newMaxLastModifiedAtMs)
            : undefined,
        };
        await prisma.syncState.upsert({
          create: state,
          update: state,
          where: {
            providerName_customerId_object: {
              providerName: data.provider_name,
              customerId: data.customer_id,
              object: data.object,
            },
          },
        });
      });
    }

    return {
      event,
      body: "Successfully copied updated records from staging into prod table",
    };
  }
);

// Create an API that serves one function
export default serve(inngest, [transformedSyncedData]);
