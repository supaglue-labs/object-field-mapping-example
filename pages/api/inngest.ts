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

    if (data.object !== "deal" && data.object !== "contact") {
      return { event, body: "Not a deal or contact sync" };
    }

    // Find high watermark for this sync
    const lastMaxLastModifiedAtMs = await step.run(
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

    const lastMaxModifiedAt = lastMaxLastModifiedAtMs
      ? new Date(lastMaxLastModifiedAtMs)
      : undefined;

    async function processOpportunities() {
      const newMaxLastModifiedAtMs = await step.run(
        "Process hubspot deals from supaglue",
        async () => {
          const supaglueDeals = await prisma.supaglueHubSpotDeal.findMany({
            where: {
              supaglue_provider_name: data.provider_name,
              supaglue_customer_id: data.customer_id,
              supaglue_last_modified_at: {
                gt: lastMaxModifiedAt,
              },
            },
          });

          if (!supaglueDeals.length) {
            return undefined;
          }

          let maxLastModifiedAtMs = 0;

          // TODO: don't iterate one by one
          for (const supaglueDeal of supaglueDeals) {
            const lastModifiedAtMs =
              supaglueDeal.supaglue_last_modified_at.getTime();
            if (lastModifiedAtMs > maxLastModifiedAtMs) {
              maxLastModifiedAtMs = lastModifiedAtMs;
            }

            if (supaglueDeal.supaglue_is_deleted) {
              // delete record
              await prisma.opportunity.deleteMany({
                where: {
                  providerName: supaglueDeal.supaglue_provider_name,
                  customerId: supaglueDeal.supaglue_customer_id,
                  originalId: supaglueDeal.supaglue_id,
                },
              });
              // delete relationships
              await prisma.opportunityToContact.deleteMany({
                where: {
                  providerName: supaglueDeal.supaglue_provider_name,
                  customerId: supaglueDeal.supaglue_customer_id,
                  originalOpportunityId: supaglueDeal.supaglue_id,
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

              // upsert record
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

              // upsert relationships
              // TODO: we should have a standard way to get associations for
              // hubspot-like providers
              const rawData = supaglueDeal.supaglue_raw_data as Record<
                string,
                any
              >;
              const relatedOriginalContactIds =
                (rawData.associations?.contacts as string[] | undefined) ?? [];
              const uniqueRelatedOriginalContactIds = [
                ...new Set(relatedOriginalContactIds),
              ];

              await prisma.opportunityToContact.createMany({
                data: uniqueRelatedOriginalContactIds.map(
                  (originalContactId) => ({
                    providerName: supaglueDeal.supaglue_provider_name,
                    customerId: supaglueDeal.supaglue_customer_id,
                    originalOpportunityId: supaglueDeal.supaglue_id,
                    originalContactId,
                    lastModifiedAt: supaglueDeal.supaglue_last_modified_at,
                  })
                ),
                skipDuplicates: true,
              });
            }
          }

          return maxLastModifiedAtMs;
        }
      );

      return newMaxLastModifiedAtMs;
    }

    async function processContacts() {
      const newMaxLastModifiedAtMs = await step.run(
        "Process hubspot contacts from supaglue",
        async () => {
          const supaglueContacts = await prisma.supaglueHubSpotContact.findMany(
            {
              where: {
                supaglue_provider_name: data.provider_name,
                supaglue_customer_id: data.customer_id,
                supaglue_last_modified_at: {
                  gt: lastMaxModifiedAt,
                },
              },
            }
          );

          if (!supaglueContacts.length) {
            return undefined;
          }

          let maxLastModifiedAtMs = 0;

          // TODO: don't iterate one by one
          for (const supaglueContact of supaglueContacts) {
            const lastModifiedAtMs =
              supaglueContact.supaglue_last_modified_at.getTime();
            if (lastModifiedAtMs > maxLastModifiedAtMs) {
              maxLastModifiedAtMs = lastModifiedAtMs;
            }

            if (supaglueContact.supaglue_is_deleted) {
              // delete record
              await prisma.contact.deleteMany({
                where: {
                  providerName: supaglueContact.supaglue_provider_name,
                  customerId: supaglueContact.supaglue_customer_id,
                  originalId: supaglueContact.supaglue_id,
                },
              });
              // delete relationships
              await prisma.opportunityToContact.deleteMany({
                where: {
                  providerName: supaglueContact.supaglue_provider_name,
                  customerId: supaglueContact.supaglue_customer_id,
                  originalContactId: supaglueContact.supaglue_id,
                },
              });
            } else {
              const mappedData = supaglueContact.supaglue_mapped_data as Record<
                string,
                any
              >;
              const data = {
                providerName: supaglueContact.supaglue_provider_name,
                customerId: supaglueContact.supaglue_customer_id,
                originalId: supaglueContact.supaglue_id,
                firstName: mappedData.firstname,
                lastName: mappedData.lastname,
                email: mappedData.email,
                phone: mappedData.phone,
                lastModifiedAt: supaglueContact.supaglue_last_modified_at,
              };

              // upsert record
              await prisma.contact.upsert({
                create: data,
                update: data,
                where: {
                  providerName_customerId_originalId: {
                    providerName: supaglueContact.supaglue_provider_name,
                    customerId: supaglueContact.supaglue_customer_id,
                    originalId: supaglueContact.supaglue_id,
                  },
                },
              });

              // upsert relationships
              // TODO: we should have a standard way to get associations for
              // hubspot-like providers
              const rawData = supaglueContact.supaglue_raw_data as Record<
                string,
                any
              >;
              const relatedOriginalDealIds =
                (rawData.associations?.deals as string[] | undefined) ?? [];
              const uniqueRelatedOriginalDealIds = [
                ...new Set(relatedOriginalDealIds),
              ];

              await prisma.opportunityToContact.createMany({
                data: uniqueRelatedOriginalDealIds.map((originalDealId) => ({
                  providerName: supaglueContact.supaglue_provider_name,
                  customerId: supaglueContact.supaglue_customer_id,
                  originalOpportunityId: originalDealId,
                  originalContactId: supaglueContact.supaglue_id,
                  lastModifiedAt: supaglueContact.supaglue_last_modified_at,
                })),
                skipDuplicates: true,
              });
            }
          }

          return maxLastModifiedAtMs;
        }
      );

      return newMaxLastModifiedAtMs;
    }

    await step.run("Update opportunity -> contact associations", async () => {
      // TODO: don't do this lookup. Just write a raw SQL statement to do the join
      // and update the relationship records

      // TODO: paginate
      const relationships = await prisma.opportunityToContact.findMany({
        where: {
          AND: [
            {
              providerName: data.provider_name,
              customerId: data.customer_id,
              // lastModifiedAt: {
              //   gt: lastMaxModifiedAt,
              // },
            },
            {
              OR: [
                {
                  opportunityId: null,
                },
                {
                  contactId: null,
                },
              ],
            },
          ],
        },
      });

      if (!relationships.length) {
        return;
      }

      const uniqueOriginalOpportunityIds = [
        ...new Set(relationships.map((r) => r.originalOpportunityId)),
      ];
      const uniqueOriginalContactIds = [
        ...new Set(relationships.map((r) => r.originalContactId)),
      ];

      const opportunities = await prisma.opportunity.findMany({
        where: {
          providerName: data.provider_name,
          customerId: data.customer_id,
          originalId: {
            in: uniqueOriginalOpportunityIds,
          },
        },
        select: {
          id: true,
          originalId: true,
        },
      });
      const contacts = await prisma.contact.findMany({
        where: {
          providerName: data.provider_name,
          customerId: data.customer_id,
          originalId: {
            in: uniqueOriginalContactIds,
          },
        },
        select: {
          id: true,
          originalId: true,
        },
      });

      const opportunityIdByOriginalId = new Map<string, string>();
      for (const opportunity of opportunities) {
        opportunityIdByOriginalId.set(opportunity.originalId, opportunity.id);
      }
      const contactIdByOriginalId = new Map<string, string>();
      for (const contact of contacts) {
        contactIdByOriginalId.set(contact.originalId, contact.id);
      }

      for (const relationship of relationships) {
        const opportunityId = opportunityIdByOriginalId.get(
          relationship.originalOpportunityId
        );
        const contactId = contactIdByOriginalId.get(
          relationship.originalContactId
        );
        await prisma.opportunityToContact.update({
          where: {
            id: relationship.id,
          },
          data: {
            opportunityId: opportunityId ?? undefined,
            contactId: contactId ?? undefined,
          },
        });
      }
    });

    const newMaxLastModifiedAtMs =
      data.object === "deal"
        ? await processOpportunities()
        : await processContacts();

    // record the high watermark seen
    if (newMaxLastModifiedAtMs) {
      await step.run("Record high watermark", async () => {
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
export default serve(inngest, [transformedSyncedData]);
