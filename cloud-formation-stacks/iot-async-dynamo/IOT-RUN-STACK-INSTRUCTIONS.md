# IoT → Kafka → DynamoDB (optional event pipeline)

Three optional stacks for an asynchronous telemetry pipeline, deployed next to the ECS stacks of this
repository. They reuse the same VPC (`aws-vpc-stack.yml`) and the same `Environment` / `ProductName` /
`AppServiceName` naming, tags and cross-stack exports.

```
+----------------+  1. MQTT telemetry   +--------------------+
|  Vehicle unit  |--------------------->|    AWS IoT Core    |
|  (device)      |<---------------------|   (MQTT broker)    |
+----------------+  4. alert / 5. ack   +--------------------+
                                                  |
                                      2. IoT rule | (Kafka action, SASL/SCRAM)
                                                  v
                                        +--------------------+
                                        |    Kafka (MSK)     |
                                        |  key = vehicleId   |
                                        +--------------------+
                                                  |
                                                  v
                                        +--------------------+
                                        | Your consumer app  |   ECS service, IAM auth
                                        | (e.g. Kafka        |   (separate service stacks)
                                        |  Streams)          |
                                        +--------------------+
                                                  |
                                      3b. persist |
                                                  v
                                        +--------------------+
                                        |      DynamoDB      |
                                        +--------------------+
```

| Stack | File | Tier | Purpose |
|---|---|---|---|
| IoT Core | [aws-iot-core-stack.yml](aws-iot-core-stack.yml) | Product, once per environment | Thing type + group, per-device MQTT policy, rule MQTT → Kafka (and/or → DynamoDB), dead-letter queue, failure alarm |
| MSK | [aws-msk-stack.yml](aws-msk-stack.yml) | Product, once per environment | Managed Kafka cluster, TLS, IAM auth for apps, SCRAM secret + KMS key for IoT Core, client policy |
| DynamoDB | [aws-dynamodb-stack.yml](aws-dynamodb-stack.yml) | Per service | On-demand encrypted table, point-in-time recovery, access policy for the task role |

None of these stacks is required by the ECS stacks, and the ECS stacks are not required by them, except the VPC.

---

## Prerequisites

- The VPC stack (`aws-vpc-stack.yml`) is deployed: the MSK stack and the IoT Kafka rule import its VPC,
  private subnets and `sg-ecs`.
- The shared PowerShell variables from section 3 of
  [RUN-STACK-INSTRUCTIONS.md](../../RUN-STACK-INSTRUCTIONS.md) (`$Environment`, `$ProductName`, `$StackPrefix`,
  `$AppServiceName`). Run every command below from the `cloud-formation-stacks` folder.
- A Kafka client for creating the topic (any machine or task inside the VPC with IAM access).

## Deploy order

```
[1] aws-dynamodb-stack.yml   → <env>-<product>-<service>-dynamodb     (per service)
[2] aws-msk-stack.yml        → <env>-<product>-msk                    (~25 min)
[3] create the Kafka topic   (manual, topics are never auto-created)
[4] aws-iot-core-stack.yml   → <env>-<product>-iot-core
```

### 1. DynamoDB table

Table `$Environment-$ProductName-$AppServiceName-table`. Encrypted with the AWS managed KMS key, on-demand
billing, point-in-time recovery on. It is **retained** when the stack is deleted (DynamoDB has no final
snapshot). The stack exports a managed policy (`...-dynamodb-access-policy-arn`) limited to this table; attach it
to the service's ECS task role.

```powershell
aws cloudformation deploy `
  --stack-name "$StackPrefix-$AppServiceName-dynamodb" `
  --template-file ./iot-async-dynamo/aws-dynamodb-stack.yml `
  --region us-east-1 `
  --capabilities CAPABILITY_NAMED_IAM `
  --parameter-overrides `
    Environment=$Environment `
    ProductName=$ProductName `
    AppServiceName=$AppServiceName
```

| Parameter | Default | Notes |
|---|---|---|
| `PartitionKeyName` / `PartitionKeyType` | `pk` / `S` | |
| `SortKeyName` / `SortKeyType` | `sk` / `S` | `SortKeyName=""` for a partition-key-only table. Use `SortKeyType=N` if IoT Core writes straight to the table (step 4, direct rule). |
| `TtlAttributeName` | empty (off) | Epoch-seconds attribute that expires items |
| `StreamViewType` | `NONE` | `NEW_AND_OLD_IMAGES` etc. to enable DynamoDB Streams |
| `PointInTimeRecovery` | `true` | |
| `DeletionProtection` | `false` | `true` for prod |

### 2. MSK (Kafka)

Provisioned cluster in the private subnets. TLS everywhere. Two authentication modes are enabled:

| Client | Mode | Port | Why |
|---|---|---|---|
| Your applications (ECS tasks) | IAM | 9098 | No passwords; scoped by the exported `...-msk-client-policy-arn` |
| AWS IoT Core rule | SASL/SCRAM-SHA-512 | 9096 | The IoT Kafka action cannot use IAM authentication |

The stack also creates the customer-managed KMS key (rotation on) and the `AmazonMSK_<env>_<product>_iot` secret
with generated credentials. MSK only accepts SCRAM secrets named `AmazonMSK_*` and encrypted with a
customer-managed key. Only `sg-ecs` can reach the brokers on 9098; the IoT rule destination adds its own 9096 rule.

```powershell
aws cloudformation deploy `
  --stack-name "$StackPrefix-msk" `
  --template-file ./iot-async-dynamo/aws-msk-stack.yml `
  --region us-east-1 `
  --capabilities CAPABILITY_NAMED_IAM `
  --parameter-overrides `
    Environment=$Environment `
    ProductName=$ProductName
```

| Parameter | Default (dev) | Prod |
|---|---|---|
| `BrokerInstanceType` | `kafka.t3.small` | `kafka.m5.large` or larger |
| `NumberOfBrokerNodes` | `2` | `4` |
| `DefaultReplicationFactor` | `2` | `3` |
| `MinInsyncReplicas` | `1` | `2` |
| `BrokerVolumeSizeGiB` | `20` | size for your retention |
| `KafkaVersion` | `3.6.0` | a version MSK supports in your region |

Cost: the dev default (2 × `kafka.t3.small`) is roughly $65/month plus storage; it runs 24/7 until deleted.

Read the broker lists:

```powershell
$MskArn = aws cloudformation describe-stacks --stack-name "$StackPrefix-msk" --region us-east-1 `
  --query "Stacks[0].Outputs[?OutputKey=='MskClusterArn'].OutputValue" --output text

# applications (IAM, :9098)
aws kafka get-bootstrap-brokers --cluster-arn $MskArn --region us-east-1 --query BootstrapBrokerStringSaslIam --output text
# IoT Core (SCRAM, :9096)
aws kafka get-bootstrap-brokers --cluster-arn $MskArn --region us-east-1 --query BootstrapBrokerStringSaslScram --output text
```

### 3. Create the Kafka topic

`auto.create.topics.enable=false`, so a typo in a producer never creates a topic by accident, and the IoT rule
fails until the topic exists. Create it from a host or task inside the VPC that has the MSK client policy
(`security.protocol=SASL_SSL`, `sasl.mechanism=AWS_MSK_IAM`):

```bash
kafka-topics.sh --bootstrap-server <iam-brokers> --command-config client.properties \
  --create --topic vehicle-telemetry --partitions 6 --replication-factor 2
```

Partitions bound the consumer parallelism (one consumer per partition inside a group); pick the number for the
fleet size you expect. Use replication factor 3 in prod.

### 4. IoT Core

Creates the device registry objects, the device policy and, depending on the parameters, up to two rules for the
topic `<env>/<product>/devices/<thingName>/telemetry`:

| Rule | Enabled by | Result |
|---|---|---|
| **Kafka** | `KafkaBootstrapServers` | Every message goes to `KafkaTopic` with **key = vehicleId** (topic segment 4), `acks=all`, SASL/SCRAM. Failed deliveries go to an SQS dead-letter queue (14 days) and the `...-iot-kafka-rule-failure` CloudWatch alarm fires. |
| **DynamoDB (direct)** | `TelemetryTableName` | Writes each message straight to the table: `TelemetryPartitionKeyName` = device id, `TelemetrySortKeyName` = arrival time in epoch ms. The table needs `SortKeyType=N`. Leave empty when a Kafka consumer does the persisting, otherwise the data is stored twice. |

```powershell
$ScramBrokers = aws kafka get-bootstrap-brokers --cluster-arn $MskArn --region us-east-1 `
  --query BootstrapBrokerStringSaslScram --output text

aws cloudformation deploy `
  --stack-name "$StackPrefix-iot-core" `
  --template-file ./iot-async-dynamo/aws-iot-core-stack.yml `
  --region us-east-1 `
  --capabilities CAPABILITY_NAMED_IAM `
  --parameter-overrides `
    Environment=$Environment `
    ProductName=$ProductName `
    KafkaBootstrapServers=$ScramBrokers `
    KafkaTopic=vehicle-telemetry
```

Optional parameters: `AlarmTopicArn` (SNS topic for the failure alarm), `LogRetentionDays`.

With `KafkaBootstrapServers` empty the stack only creates the device registry objects, the policy and (if set)
the direct DynamoDB rule, so you can deploy IoT Core before MSK exists and add the Kafka rule later by
re-deploying with the brokers.

---

## Onboard a device and test

Devices are provisioned per device or per fleet, not by CloudFormation.

```powershell
$Thing = "vehicle-001"
aws iot create-thing --thing-name $Thing --thing-type-name "$Environment-$ProductName-device" --region us-east-1
aws iot add-thing-to-thing-group --thing-name $Thing --thing-group-name "$Environment-$ProductName-devices" --region us-east-1

aws iot create-keys-and-certificate --set-as-active --region us-east-1 `
  --certificate-pem-outfile "$Thing.pem" --public-key-outfile "$Thing.pub" --private-key-outfile "$Thing.key"
# note the certificateArn from the output, then:
aws iot attach-policy --policy-name "$Environment-$ProductName-iot-device-policy" --target <certificateArn> --region us-east-1
aws iot attach-thing-principal --thing-name $Thing --principal <certificateArn> --region us-east-1

aws iot describe-endpoint --endpoint-type iot:Data-ATS --region us-east-1   # MQTT endpoint
```

The device policy only lets a device connect with a client id equal to its thing name, publish under
`<env>/<product>/devices/<thingName>/*`, and subscribe to / receive from
`<env>/<product>/devices/<thingName>/commands/*`. Use the `commands` subtree for the alert and ack messages
(steps 4 and 5 of the diagram).

To test, connect with the certificate (client id = `vehicle-001`), publish with **QoS 1** to
`<env>/<product>/devices/vehicle-001/telemetry`, then consume `vehicle-telemetry` and check that the record
key is `vehicle-001`. In the IoT console, the **MQTT test client** can do the publish.

## Making sure messages reach Kafka

| Hop | What protects delivery |
|---|---|
| Device → IoT Core | Publish with MQTT QoS 1 and use persistent sessions (`cleanSession=false`): at-least-once to the broker |
| IoT Core → Kafka | `acks=all`; failed deliveries land in the SQS dead-letter queue; alarm on the rule's `Failure` metric |
| Inside Kafka | Replication factor and `MinInsyncReplicas` (see the prod column above); with `MinInsyncReplicas=1` an acknowledged message can be lost if the one in-sync broker fails |
| Kafka → consumer | Commit offsets after processing; make processing idempotent, because at-least-once delivery means duplicates are possible (for example key DynamoDB writes by a message id) |

Watch consumer lag and the IoT `Rule.Failure` / `Kafka.Failure` / `RuleMessageThrottled` CloudWatch metrics.
Replay messages from the dead-letter queue after fixing the cause.

## Letting a service use these resources

Both stacks export managed policies. Attach them to the ECS task role of the consuming service (the existing
[aws-iam-stack.yml](../per-service/aws-iam-stack.yml) does not do this for you):

| Export | Grants |
|---|---|
| `<env>-<product>-<service>-dynamodb-access-policy-arn` | Read/write on that service's table only |
| `<env>-<product>-msk-client-policy-arn` | Connect, produce, consume on the product's cluster (IAM) |

## Exports

| Stack | Export |
|---|---|
| DynamoDB | `<env>-<product>-<service>-dynamodb-table-name`, `...-table-arn`, `...-access-policy-arn` |
| MSK | `<env>-<product>-msk-cluster-arn`, `...-msk-sg-id`, `...-msk-client-policy-arn`, `...-msk-scram-secret-arn`, `...-msk-scram-key-arn` |
| IoT Core | `<env>-<product>-iot-device-policy-name`, `...-iot-thing-type-name`, `...-iot-thing-group-name` |

## Teardown (reverse order)

```
[1] <env>-<product>-iot-core         ← removes the rules, destination, queue, alarm
[2] <env>-<product>-msk              ← removes the cluster, secret, KMS key (scheduled for deletion)
[3] <env>-<product>-<service>-dynamodb   ← the table itself is retained; delete it manually if the data is not needed
```

Detach the exported managed policies from the task role first, otherwise the stack deletions fail because the
exports are still in use. Delete the retained table with
`aws dynamodb delete-table --table-name <name>` (turn off `DeletionProtection` first if it was on).

## Known limitations

- The Kafka rule needs the SCRAM broker list as a parameter because CloudFormation cannot read MSK bootstrap
  brokers; re-deploy the IoT stack if the cluster is replaced.
- The MSK subnets are the two private subnets of the VPC stack, so brokers are spread over two Availability
  Zones. A replication factor of 3 therefore needs `NumberOfBrokerNodes=4` (two per AZ).
- The IoT rule destination creates network interfaces in the private subnets; they can take a few minutes to
  become `ENABLED`.
- The templates have not been run against a live account yet: validate them (`aws cloudformation validate-template`
  or `cfn-lint`) and deploy to `dev` first.
