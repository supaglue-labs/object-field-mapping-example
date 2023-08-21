import { Contact, MapperAny, Opportunity, UserConfig } from "./types";

// This user has normal HubSpot contact and deal objects.
const user1: UserConfig = {
  providerName: "hubspot",
  entityMappings: {
    contact: {
      object: "contact",
      mappingFn: (record: Record<string, string | null>): Contact => ({
        firstName: record["firstname"],
        lastName: record["lastname"],
      }),
    },
    opportunity: {
      object: "deal",
      mappingFn: (record: Record<string, string | null>): Opportunity => {
        const hs_deal_stage_probability = record["hs_deal_stage_probability"];
        const probability =
          hs_deal_stage_probability !== null
            ? parseFloat(hs_deal_stage_probability)
            : null;
        return {
          name: record["dealname"],
          description: record["description"],
          probability,
        };
      },
    },
  },
};

// This user uses Salesforce Lead and has a special Opportunity object with
// a ProbabilityV2__c field that is a picklist of values [10, 20, ..., 100].
const user2: UserConfig = {
  providerName: 'salesforce',
  entityMappings: {
    contact: {
      object: 'Lead',
      mappingFn: (record: Record<string, string>): Contact => ({
        firstName: record['FirstName'],
        lastName: record['LastName'],
      }),
    },
    opportunity: {
      object: 'Opportunity',
      mappingFn: (record: Record<string, string>): Opportunity => ({
        name: record['Name'],
        description: record['Description'],
        probability: parseInt(record['ProbabilityV2__c']) / 100,
      }),
    },
  }
};

// This user uses Salesforce Contact and has a normal Opportunity object.
const user3: UserConfig = {
  providerName: 'salesforce',
  entityMappings: {
    contact: {
      object: 'Contact',
      mappingFn: (record: Record<string, string>): Contact => ({
        firstName: record['FirstName'],
        lastName: record['LastName'],
      }),
    },
    opportunity: {
      object: 'Opportunity',
      mappingFn: (record: Record<string, string>): Opportunity => ({
        name: record['Name'],
        description: record['Description'],
        probability: parseFloat(record['Probability']) / 100,
      }),
    },
  }
}

const userConfigs: Record<string, UserConfig> = {
  user1,
  user2,
  user3,
};

export const getMapper = (
  providerName: string,
  customerId: string,
  object: string
): MapperAny | null => {
  const config = userConfigs[customerId];
  if (!config) {
    return null;
  }

  if (config.providerName !== providerName) {
    return null;
  }

  // Find the corresponding entity name and mapper
  for (const [entityName, entityMappingConfig] of Object.entries(config.entityMappings)) {
    if (entityMappingConfig.object === object) {
      return {
        object,
        entityName,
        mappingFn: entityMappingConfig.mappingFn,
      } as MapperAny; // TODO: types
    }
  }
}
