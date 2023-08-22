

export type Contact = {
  firstName: string;
  lastName: string;
};

export type Opportunity = {
  name: string;
  description: string;
  probability: number; // number between 0 and 1.0
};

// scaffolding

export type UserConfig = {
  providerName: 'hubspot' | 'salesforce';
  entityMappings: {
    contact: EntityMappingConfig<'contact'>;
    opportunity: EntityMappingConfig<'opportunity'>;
  }
};

type EntityMappingConfig<T extends EntityName> = {
  object: string;
  mappingFn: (record: Record<string, unknown>) => NameToEntity<T>;
}

export type Entity = Contact | Opportunity;
export type EntityName = 'contact' | 'opportunity';

export type NameToEntity<T extends EntityName> = {
  contact: Contact;
  opportunity: Opportunity;
}[T];

export type Mapper<T extends EntityName> = {
  object: string;
  entityName: T;
  mappingFn: (record: Record<string, unknown>) => NameToEntity<T>;
};

export type MapperAny = Mapper<'contact'> | Mapper<'opportunity'>;
