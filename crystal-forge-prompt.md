# AI Harness Platform – Technical Summary

## Objective

Build an internal AI-powered platform ("harness") that enables developers, analysts, and business users to:

* Query company data
* Generate and execute code
* Perform analysis
* Build lightweight internal tools

All within a **secure, governed, and proprietary environment**.  In some ways I've thought of this as "Loveable.com" tailored for internal crystal use.

I call it Crystal Forge.

---

## Core Concept

The system is **not a single application**. It is a layered platform that connects:

* AI models (e.g., Claude Code)
* Company data (ERP, shared drives, APIs)
* Execution environments
* User-facing interfaces
* Governance tools, GitHub, Monday.com

> The harness = controlled environment where AI + users interact with internal systems to produce work.

---

## High-Level Architecture

```
Data Sources (ERP, Shared Drive, APIs)
        ↓
Ingestion & Sync Layer
        ↓
Storage Layer (Postgres + Object Storage)
        ↓
Indexing Layer (Chunks + Embeddings)
        ↓
Retrieval Layer (Hybrid Search + ACL Filtering)
        ↓
AI Orchestration Layer
        ↓
Execution Layer (SQL, Java Spring Boot, Python sandbox)
        ↓
User Interface (Chat / Tools / Apps / Dashboards, build with React Typescript)
```

---

## Data Layer Design

### 1. Storage Components

#### A. Postgres (Primary System)

Used for:

* Metadata
* ERP mirror (structured data)
* Document chunks
* Embeddings (via pgvector)
* Permissions (ACLs)

#### B. Object Storage

Used for raw files:

* MinIO / S3-compatible / Azure Blob / NAS

Do not store large files directly in Postgres.

---

### 2. Document Ingestion (Shared Drives)

#### Process

1. Crawl shared drive
2. Detect changes using:

   * modified timestamp
   * file size
   * content hash
3. Extract text
4. Chunk content
5. Generate embeddings
6. Store in Postgres

#### Key Tables

**documents**

* id
* source_system
* path
* file_name
* mime_type
* last_modified
* content_hash

**document_chunks**

* id
* document_id
* chunk_text
* embedding
* metadata

---

### 3. Vector Search Strategy

Use:

* **pgvector** for embeddings
* **Postgres full-text search** for keyword matching

This enables **hybrid search**:

* semantic (meaning)
* keyword (exact terms like SKUs, names)

Avoid starting with a standalone vector DB unless scale requires it.

---

### 4. ERP Data Strategy (Epicor)

ERP data should remain **structured**, not embedded.

#### Approach

* Mirror key tables into Postgres
* Provide read-only SQL access to AI

#### Example Tables

* customers
* orders
* jobs
* inventory
* invoices

#### Why

* Accurate aggregation
* Fast queries
* Avoids embedding millions of rows

---

## Data Synchronization

### Phase 1 – MVP (Recommended)

* Nightly batch sync from ERP
* Scheduled crawler for shared drive

### Phase 2 – Incremental

* Sync only changed records
* Use timestamps or version columns

### Phase 3 – Real-Time (Optional)

* CDC (Change Data Capture)
* Kafka / Debezium pipeline

---

## Permissions Model (Critical)

All data must be access-controlled **before retrieval**.

#### ACL Table

**document_acl**

* document_id
* principal_type (user/group)
* principal_id

#### Enforcement

* Apply ACL filters at query time
* Never expose unauthorized data to the LLM

---

## AI Layer

### Responsibilities

* Interpret user requests
* Generate SQL / code
* Call tools (query DB, run Python)
* Combine results

### Model Types

#### 1. Embedding Model

* Converts text → vectors
* Can be local or hosted

#### 2. LLM (Claude Code, etc.)

* Reasoning
* Code generation

#### 3. Optional Reranker

* Improves search quality

---

## Execution Layer

Sandboxed environment to run:

* SQL queries (read-only)
* Python scripts
* Run in isolated containers

Must include:

* resource limits
* timeouts
* isolation (containers recommended)

---

## Example Workflow

User:

> "Show top maintenance cost drivers"

System:

1. AI generates SQL
2. Executes query
3. Analyzes results
4. Returns table + chart + explanation

---


## Recommended Tech Stack

* Backend: Java Spring Boot
* Frontend:  React + Typescript
* Database: Postgres
* Vector: pgvector
* Storage: MinIO / S3-compatible
* Queue: Redis / Celery / BullMQ
* AI Orchestration: LlamaIndex / LangChain (light use)
* LLM: Claude / approved provider
* Auth: SSO (Entra ID)

---

## Key Design Principles

1. **LLM is not a database**
2. **Vector DB is not a source of truth**
3. **Structured data stays relational**
4. **Unstructured data uses embeddings**
5. **Permissions enforced before retrieval**
6. **Start simple, evolve incrementally**

---

## Success Criteria

* Users can query internal data in natural language
* Analysts reduce time-to-insight significantly
* Developers accelerate internal tool creation
* System maintains strict data governance

---

## Summary

This platform is a:

> **Private AI-enabled data + execution layer that allows employees to analyze, build, and automate using company data safely and efficiently.**

It combines:

* Data indexing
* Secure execution
* AI orchestration

into a unified internal system (the "harness").
