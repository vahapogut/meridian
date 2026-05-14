/// Schema definition system for Meridian Flutter client.

class FieldDef {
  final String type; // 'string', 'number', 'boolean', 'array', 'object'
  final bool required;
  final dynamic defaultValue;

  FieldDef({required this.type, this.required = true, this.defaultValue});
}

class CollectionSchema {
  final Map<String, FieldDef> fields;

  CollectionSchema({required this.fields});

  Map<String, dynamic> getDefaults() {
    final defaults = <String, dynamic>{};
    for (final entry in fields.entries) {
      if (entry.value.defaultValue != null) {
        defaults[entry.key] = entry.value.defaultValue;
      }
    }
    return defaults;
  }
}

class SchemaDefinition {
  final int version;
  final Map<String, CollectionSchema> collections;

  SchemaDefinition({required this.version, required this.collections});

  void validate() {
    for (final entry in collections.entries) {
      if (!entry.value.fields.containsKey('id')) {
        throw ArgumentError('Collection "${entry.key}" must have an "id" field');
      }
    }
  }
}
