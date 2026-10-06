# Reusable AWS CloudFormation — ECS Fargate Microservices

Reusable, parameter-driven **AWS CloudFormation** templates to host one or many containerized
microservices on **ECS Fargate**, with a shared network and load balancer, a per-service
CI/CD pipeline, and an optional per-service **Aurora PostgreSQL** database.

Nothing is product-specific: every name is derived from three parameters —
`Environment`, `ProductName` and `AppServiceName` — so the same templates can be reused for any
product, environment (`dev` / `staging` / `prod`) and service.

---

## What you get

| Concern | Provided by |
|---|---|
| Network (VPC, 2 public + 2 private subnets, IGW, NAT, security groups) | `aws-vpc-stack.yml` |
| Shared ECS cluster + internet-facing Application Load Balancer | `aws-ecs-infra-stack.yml` |
| Docker build from GitHub → ECR (immutable tags, scan on push) | `per-service/aws-codebuild-stack.yml` |
| ECS task execution role + task role | `per-service/aws-iam-stack.yml` |
| Amazon Bedrock invoke permissions for the task role, for any model provider (optional) | `per-service/aws-bedrock-iam-stack.yml` |
| Aurora PostgreSQL Serverless v2, managed secret, subnet group, SG | `per-service/aws-rds-aurora-stack.yml` |
| Task definition, ECS service, target group, ALB path rule | `per-service/aws-ecs-service-stack.yml` |
| Auto-redeploy on every successful build (EventBridge + Lambda) | `per-service/aws-pipeline-stack.yml` |
| IoT Core (MQTT) → MSK (Kafka) → DynamoDB event pipeline (optional, separate set of stacks) | [`iot-async-dynamo/`](cloud-formation-stacks/iot-async-dynamo/IOT-RUN-STACK-INSTRUCTIONS.md) |

---

## Amazon Bedrock models

A service that calls Amazon Bedrock gets its permissions from the optional `aws-bedrock-iam-stack.yml`.
It is model-agnostic: it works for Anthropic Claude, AI21 Jamba, Amazon Nova, Mistral and the other
providers Bedrock offers, because you choose the model with two parameters.

| Parameter | What to set |
|---|---|
| `BedrockModelId` | The foundation model ID, e.g. `ai21.jamba-1-5-mini-v1:0`. Default `*` allows every model; set one for least privilege. |
| `InferenceProfileId` | Only for models that cannot be called directly and need a (cross-region) inference profile, e.g. `us.anthropic.claude-haiku-4-5-20251001-v1:0`. Leave empty otherwise. |

Examples, checked against `us-east-1`:

| Provider | `BedrockModelId` | `InferenceProfileId` |
|---|---|---|
| Anthropic Claude Haiku 4.5 | `anthropic.claude-haiku-4-5-20251001-v1:0` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| AI21 Jamba 1.5 Mini (marked `LEGACY` by Bedrock, so it may be retired) | `ai21.jamba-1-5-mini-v1:0` | _(empty)_ |
| Amazon Nova Pro | `amazon.nova-pro-v1:0` | _(empty), or `us.amazon.nova-pro-v1:0`_ |
| Mistral Large 3 | `mistral.mistral-large-3-675b-instruct` | _(empty)_ |

To allow several models for one service, deploy the stack once per model with a different stack name; the model
ID is part of the policy and export names, so the stacks do not clash.

Availability changes by region and over time. List what your account can call with
`aws bedrock list-foundation-models` and `aws bedrock list-inference-profiles`; the `modelLifecycle` status
(`ACTIVE` or `LEGACY`) shows whether a model is being phased out. Each model also
needs model access in the Bedrock console, and quotas (requests and tokens per minute and per day) are
set per model. Anthropic models additionally need a one-time use case form; see
[RUN-STACK-INSTRUCTIONS.md](RUN-STACK-INSTRUCTIONS.md#step-4b-bedrock-iam-optional).

---

## Architecture

Infrastructure has two tiers. The **product tier** is deployed once per environment; the
**service tier** is deployed once per microservice and shares everything in the product tier.

```
PRODUCT TIER (once per product × environment)
  vpc        → VPC, subnets, IGW, NAT Gateway, sg-alb, sg-ecs
  ecs-infra  → ECS cluster + ALB + HTTP :80 listener (default action: 404)

SERVICE TIER (once per microservice × environment)
  codebuild    → ECR repository + CodeBuild project (GitHub → Docker → ECR)
  iam          → ECS task execution role + task role
  rds          → Aurora PostgreSQL cluster + secret (optional, if the service needs a DB)
  ecs-service  → task definition + ECS service + target group + ALB rule  /<AppServiceName>/*
  pipeline     → EventBridge rule + Lambda that redeploys the service after a build
```

```
Internet
   │
   ▼
ALB (public subnets, HTTP :80)
   ├── /catalog/*  → Target group → ECS service "catalog"  ─┐
   ├── /orders/*   → Target group → ECS service "orders"   ─┼─► Fargate tasks (private subnets)
   └── anything else → 404                                  ─┘        │ outbound via NAT
                                                                      ▼
                                                        Aurora PostgreSQL (per service)
```

```
Delivery flow (per service)

GitHub ──► CodeBuild ──► ECR
              │ build SUCCEEDED
              ▼
        EventBridge ──► Lambda ──► new task definition revision ──► ECS service (rolling redeploy)
                          ▲
                          └── image tag read from SSM Parameter Store
```

### AWS services diagram

![AWS architecture of the dev portfolio environment: shared VPC, ALB and ECS cluster, the webstore and yourOtherService Fargate services with their Aurora PostgreSQL clusters, and each service's CodeBuild, ECR, EventBridge and Lambda deployment flow](docs/diagram/aws-architecture.gif)

The editable source is [`docs/diagram/aws-architecture.drawio`](docs/diagram/aws-architecture.drawio), generated by
[`docs/diagram/generate-aws-architecture.js`](docs/diagram/generate-aws-architecture.js). A text version is in
[`docs/diagram/aws-architecture.txt`](docs/diagram/aws-architecture.txt).

> **Note:** the [`docs/diagram/`](docs/diagram/) folder has the diagram source. You can use a generative AI
> assistant to update it to your needs: for example, ask it to change the product and service names, task counts or
> stacks in `generate-aws-architecture.js`, then run `node generate-aws-architecture.js` to regenerate the
> `.drawio` file and open it in [draw.io](https://app.diagrams.net) to review and export a new image.

### Design decisions

- **Shared cluster and ALB, path-based routing.** Each service is reachable at `/<AppServiceName>/*`
  and needs a unique `ListenerRulePriority`. The app must run with
  `server.servlet.context-path=/<AppServiceName>`.
- **Image tag lives in SSM, not in the template.** The task definition resolves
  `<ecr-uri>:{{resolve:ssm:/<env>-<product>-<service>-imageTag}}`. There is no `ImageTag`
  parameter on the service stack.
- **`DesiredCount` defaults to `0`.** CloudFormation creates the service without starting tasks;
  you start and scale them explicitly (see [`RUN-STACK-INSTRUCTIONS.md`](RUN-STACK-INSTRUCTIONS.md)).
- **Task definitions are retained** (`DeletionPolicy: Retain`) so old revisions stay available for rollback.
- **Tasks run in private subnets** with `awsvpc` networking and target type `ip`; only the ALB is public.
- **No plaintext secrets.** The database password is generated and stored in Secrets Manager;
  the task receives `DB_HOST`, `DB_PORT`, `DB_NAME` and the secret reference.
- **Stacks are wired with `Fn::ImportValue` / `Outputs.Export`**, never copied ARNs.
- **Aurora keeps a final snapshot** on delete (`DeletionPolicy: Snapshot`).

---

## Repository layout

```
README.md
RUN-STACK-INSTRUCTIONS.md               # full deploy / operate command reference (PowerShell)
docs/
├── aws-cloud-formation-web-console.png   # CloudFormation console screenshot
├── ecs-fargate-instances.png             # ECS console screenshot
└── diagram/                              # architecture diagram: source, generator, exports
cloud-formation-stacks/
├── aws-vpc-stack.yml               # product tier: network
├── aws-ecs-infra-stack.yml         # product tier: ECS cluster + ALB
├── iot-async-dynamo/               # optional: IoT Core + MSK + DynamoDB (own run instructions)
│   ├── aws-iot-core-stack.yml
│   ├── aws-msk-stack.yml
│   └── aws-dynamodb-stack.yml
└── per-service/
    ├── aws-codebuild-stack.yml     # ECR + CodeBuild
    ├── aws-iam-stack.yml           # ECS roles
    ├── aws-rds-aurora-stack.yml    # Aurora PostgreSQL Serverless v2
    ├── aws-ecs-service-stack.yml   # task definition, service, target group, ALB rule
    └── aws-pipeline-stack.yml      # auto-redeploy on build success
```

---

## Naming conventions

| Item | Pattern | Example (`dev`, `shop`, `catalog`) |
|---|---|---|
| Stack (product tier) | `<env>-<product>-<tier>` | `dev-shop-vpc`, `dev-shop-ecs-infra` |
| Stack (service tier) | `<env>-<product>-<service>-<tier>` | `dev-shop-catalog-ecs-service` |
| ECS cluster | `<env>-<product>-cluster` | `dev-shop-cluster` |
| ECS service | `<env>-<product>-<service>-service` | `dev-shop-catalog-service` |
| ECR repository | `<env>-<product>-<service>-repo` | `dev-shop-catalog-repo` |
| SSM image tag | `/<env>-<product>-<service>-imageTag` | `/dev-shop-catalog-imageTag` |
| Export names | `<env>-<product>[-<service>]-<output>` | `dev-shop-vpc-id` |

---

## Prerequisites

- An AWS account and the [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), authenticated (`aws login` or any profile).
- A **GitHub CodeConnections** connection in `AVAILABLE` state (AWS Console → CodeBuild → Source credentials → GitHub → OAuth). Its ARN is passed as `GitHubConnectionArn`; the template has no default for it.
- A `Dockerfile` and a **`buildspec.yml` in the application repository** (your service). See [Your application needs a `buildspec.yml`](#your-application-needs-a-buildspecyml) below.

Set the shared variables once per shell session (PowerShell shown; the same values apply to any shell).
Don't hardcode account IDs, ARNs or tokens in committed files.

```powershell
$Environment         = "dev"                      # dev | staging | prod
$ProductName         = "portfolio"
$AppServiceName      = "webstore"
$StackPrefix         = "$Environment-$ProductName"   # -> "dev-portfolio"
$AwsAccountId        = "<12-digit AWS account id>"
$GitHubConnectionArn = "<arn:aws:codeconnections:...>"   # create it first: RUN-STACK-INSTRUCTIONS.md, "2. GitHub connection (private repositories)"
$GitHubOwner         = "<github org or user>"
$GitHubRepo          = "<repository name>"
$GitHubBranch        = "main"
```

### Your application needs a `buildspec.yml`

These templates only create the build project. **The build steps come from your application (service)
repository:** it must contain a `buildspec.yml` at the repository root (or at the path you pass as the
`BuildSpecFile` parameter of the CodeBuild stack) and a `Dockerfile`. Without it, CodeBuild has nothing to run
and no image reaches ECR.

The CodeBuild project (privileged mode, so Docker works) provides these environment variables to your buildspec:

| Variable | Value |
|---|---|
| `AWS_DEFAULT_REGION` | Region of the stack |
| `AWS_ACCOUNT_ID` | The `AwsAccountId` parameter |
| `ECR_REPO` | `<env>-<product>-<service>-repo` |
| `IMAGE_TAG` | `latest` by default; override it per build with `--environment-variables-override name=IMAGE_TAG,...` |

Your buildspec must log in to ECR, build the image, and **push it tagged with `$IMAGE_TAG`**. The auto-deploy
Lambda reads `IMAGE_TAG` from the finished build and rolls the ECS service to that tag. The ECR repository has
immutable tags, so each build needs a tag that hasn't been pushed before.

A minimal example (adapt it to your build; it is not tested against this repository):

```yaml
version: 0.2

phases:
  pre_build:
    commands:
      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com
  build:
    commands:
      - docker build -t $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$ECR_REPO:$IMAGE_TAG .
  post_build:
    commands:
      - docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$ECR_REPO:$IMAGE_TAG
```

---

## Deploy

Run from the `cloud-formation-stacks/` folder. Every `aws cloudformation deploy` call uses
`--capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND` and `--region <region>`.

### Order

| # | Tier | Step | Stack name |
|---|---|---|---|
| 1 | Product | `aws-vpc-stack.yml` | `$StackPrefix-vpc` |
| 2 | Product | `aws-ecs-infra-stack.yml` | `$StackPrefix-ecs-infra` |
| 3 | Service | `per-service/aws-codebuild-stack.yml` | `$StackPrefix-$AppServiceName-codebuild` |
| 4 | Service | `per-service/aws-iam-stack.yml` | `$StackPrefix-$AppServiceName-iam` |
| 5 | Service | `per-service/aws-rds-aurora-stack.yml` *(optional but required by the current service stack, which imports the DB outputs)* | `$StackPrefix-$AppServiceName-rds` |
| 6 | Service | `aws ssm put-parameter` for the image tag | — |
| 7 | Service | `per-service/aws-ecs-service-stack.yml` | `$StackPrefix-$AppServiceName-ecs-service` |
| 8 | Service | `per-service/aws-pipeline-stack.yml` | `$StackPrefix-$AppServiceName-pipeline` |

Example for one stack (all others follow the same shape; see
[`RUN-STACK-INSTRUCTIONS.md`](RUN-STACK-INSTRUCTIONS.md) for every command with its parameters):

```powershell
aws cloudformation deploy `
  --stack-name "$StackPrefix-vpc" `
  --template-file ./aws-vpc-stack.yml `
  --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND `
  --parameter-overrides Environment=$Environment ProductName=$ProductName
```

---
#### AWS WEB CONSOLE

This is the CloudFormation console after running the deploy steps above for one real example:
environment `dev`, product `portfolio`, service `webstore` (`$StackPrefix` = `dev-portfolio`).
The 8 steps produce **7 stacks**, because step 6 is an SSM parameter and not a stack. All of them
show a `*_COMPLETE` status.

| Tier | Stack | Step |
|---|---|---|
| Product | `dev-portfolio-vpc` | 1 |
| Product | `dev-portfolio-ecs-infra` | 2 |
| Service | `dev-portfolio-webstore-codebuild` | 3 |
| Service | `dev-portfolio-webstore-iam` | 4 |
| Service | `dev-portfolio-webstore-rds` | 5 |
| Service | `dev-portfolio-webstore-ecs-service` | 7 |
| Service | `dev-portfolio-webstore-pipeline` | 8 |

The two product-tier stacks are shared. A second microservice would add its own five service-tier stacks
next to these, named `dev-portfolio-<service>-…`.

![AWS CloudFormation console listing the seven dev-portfolio stacks, all in a COMPLETE status](docs/aws-cloud-formation-web-console.png)

### First deploy of a service

1. Deploy steps 1–5, then create the image-tag parameter before the service stack:
   ```powershell
   aws ssm put-parameter --name "/$StackPrefix-$AppServiceName-imageTag" `
     --value 1.0.0 --type String
   ```
2. Build and push the first image:
   ```powershell
   aws codebuild start-build --project-name "$StackPrefix-$AppServiceName-codebuild" `
     --environment-variables-override name=IMAGE_TAG,value=1.0.0,type=PLAINTEXT
   ```
3. Deploy the service stack (unique `ListenerRulePriority` per service), then the pipeline stack.
4. Start the tasks (`DesiredCount` is `0` by default):
   ```powershell
   aws ecs update-service --cluster "$StackPrefix-cluster" `
     --service "$StackPrefix-$AppServiceName-service" `
     --desired-count 3 --force-new-deployment
   ```
After that, every successful CodeBuild build redeploys the service automatically.

### AWS WEB Console 
   The screenshots below is the result of this step in the `dev` / `portfolio` / `webstore`.

#### ECS / APPLICATON INSTANCES       
   ECS console for `dev-portfolio-cluster`, where the service tasks are **Running** as Fargate tasks
   (here 3 running, 0 pending) from task definition `dev-portfolio-webstore-task`.

   ![ECS console for dev-portfolio-cluster listing the webstore Fargate tasks in a Running state](docs/ecs-fargate-instances.png)


#### RDS (Aurora PostgreSQL)

The screenshot shows the RDS console (**Aurora and RDS → Databases**) after the RDS stack was deployed for the
`dev` / `portfolio` / `webstore` example. The stack creates one Aurora PostgreSQL cluster per service, and the list
has the two entries you should expect for it:

| DB identifier | Role | Notes |
|---|---|---|
| `dev-portfolio-webstore-cluster` | Regional cluster | Aurora PostgreSQL, 1 instance, status **Available** |
| `dev-portfolio-webstore-instance-1` | Writer instance | Aurora Serverless v2 instance in `us-east-1a`, status **Available** |

![RDS console listing the dev-portfolio-webstore Aurora cluster and its writer instance, both Available](docs/aws-rds.png)

The cluster is private (no public access, port 5432 open only to the ECS tasks), but you can still query it from the
Console. The RDS stack enables the **RDS Data API** (`EnableHttpEndpoint: true`), which the **Query editor** uses over
HTTPS, so it needs no network path to port 5432. In the Query editor choose **Connect with a Secrets Manager ARN** and
select the `$StackPrefix-$AppServiceName-db-secret` secret, so you never type the credentials.

> For anything beyond quick checks, prefer a proper migration tool over ad-hoc edits in the Query editor.

### Adding another microservice

Deploy steps 3–8 again with a new `AppServiceName` and a new `ListenerRulePriority`.
The VPC, cluster and ALB are reused.

### Teardown (reverse order)

`ecs-service` → `pipeline` → `rds` (final snapshot is taken) → `iam` → `codebuild` → `ecs-infra` → `vpc`.
Delete all service-tier stacks of every service before the product-tier stacks, because
the product tier's exports are in use.

---

## Parameters you will most often set

| Parameter | Stack | Default | Notes |
|---|---|---|---|
| `Environment` | all | `dev` | `dev`, `staging` or `prod` |
| `ProductName` | all | — | Required |
| `AppServiceName` | service tier | — | Required |
| `AwsAccountId` | ecs-infra, codebuild, pipeline | — | Required |
| `GitHubOwner`, `GitHubRepo`, `GitHubConnectionArn` | codebuild | — | Required; `GitHubBranch` defaults to `main` |
| `ContainerPort` | vpc, ecs-service | `8080` | Keep both in sync |
| `HealthCheckPath` | ecs-service | `/actuator/health` | Pass only the suffix; the template prepends `/<AppServiceName>` |
| `ListenerRulePriority` | ecs-service | — | Unique per service on the shared ALB |
| `TaskCpu` / `TaskMemory` | ecs-service | `512` / `1024` | Must be a valid Fargate combination |
| `DesiredCount` | ecs-service | `0` | Scale after deploy |
| `DbName`, `ServerlessMinCapacity`, `ServerlessMaxCapacity` | rds | `appdb`, `0.5`, `2` | Aurora capacity units |
| `DeletionProtection`, `BackupRetentionDays` | rds | `false`, `7` | Enable protection in `prod` |

Each template's `Parameters` section is the source of truth for the full list.

---

## Known limitations

- The ALB listens on **HTTP :80 only**. Add an ACM certificate and an HTTPS listener before exposing production traffic.
- A **single NAT Gateway** serves both private subnets — cheap, but not zone-fault tolerant.
- **Fargate only.** There is no EC2 capacity (ASG / capacity provider) variant in this repository.
- The service stack currently **requires the RDS stack** (it imports its outputs). A service without a database needs those imports and environment variables removed.
