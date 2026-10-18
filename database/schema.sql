-- Esquema de compliance_db (compliance-service). Generado con pg_dump --schema-only desde la base
-- que crea TypeORM a partir de las entidades (src/**/entities, synchronize: true).
-- Restaurar en una base vacía:  psql "$DATABASE_URL" -f database/schema.sql

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    staff_id character varying NOT NULL,
    staff_username character varying NOT NULL,
    action character varying NOT NULL,
    target_type character varying NOT NULL,
    target_id character varying NOT NULL,
    reason character varying(300),
    details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    staff_role character varying
);


--
-- Name: aml_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aml_reports (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    period_from date NOT NULL,
    period_to date NOT NULL,
    generated_by character varying NOT NULL,
    total_transactions integer NOT NULL,
    total_volume numeric(18,2) NOT NULL,
    flagged_count integer NOT NULL,
    sar_count integer NOT NULL,
    new_accounts integer NOT NULL,
    kyc_approval_rate numeric(5,2),
    payload jsonb NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: compliance_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.compliance_accounts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    id_user character varying NOT NULL,
    email character varying,
    nombre_completo character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: compliance_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.compliance_identities (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    id_user character varying NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    rejected_count integer DEFAULT 0 NOT NULL,
    last_event_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: compliance_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.compliance_transactions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    transaction_id uuid NOT NULL,
    account_id uuid NOT NULL,
    id_user character varying NOT NULL,
    type character varying NOT NULL,
    direction character varying NOT NULL,
    amount numeric(18,2) NOT NULL,
    currency character varying(3) NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: suspicious_activity_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suspicious_activity_reports (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    id_user character varying NOT NULL,
    account_id uuid,
    transaction_id uuid,
    reason character varying(500) NOT NULL,
    severity character varying NOT NULL,
    source character varying NOT NULL,
    status character varying DEFAULT 'open'::character varying NOT NULL,
    filed_by character varying,
    filed_at timestamp with time zone,
    resolution_note character varying(300),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: aml_reports PK_0531db1fbbcd055b07e22556bc0; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aml_reports
    ADD CONSTRAINT "PK_0531db1fbbcd055b07e22556bc0" PRIMARY KEY (id);


--
-- Name: compliance_transactions PK_241ca630725949a599084d28dd3; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compliance_transactions
    ADD CONSTRAINT "PK_241ca630725949a599084d28dd3" PRIMARY KEY (id);


--
-- Name: admin_audit PK_5ad48a4d9d16397ef37e28bb0be; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit
    ADD CONSTRAINT "PK_5ad48a4d9d16397ef37e28bb0be" PRIMARY KEY (id);


--
-- Name: suspicious_activity_reports PK_9c3c5c32ef63a2e2b4b3d7fef94; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suspicious_activity_reports
    ADD CONSTRAINT "PK_9c3c5c32ef63a2e2b4b3d7fef94" PRIMARY KEY (id);


--
-- Name: compliance_accounts PK_9c5fc824dd7767323ceffb80b18; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compliance_accounts
    ADD CONSTRAINT "PK_9c5fc824dd7767323ceffb80b18" PRIMARY KEY (id);


--
-- Name: compliance_identities PK_b47b16539ebdde6b1f792404bc7; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compliance_identities
    ADD CONSTRAINT "PK_b47b16539ebdde6b1f792404bc7" PRIMARY KEY (id);


--
-- Name: compliance_identities UQ_09919bdac6f0f59b0cd64d713a2; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compliance_identities
    ADD CONSTRAINT "UQ_09919bdac6f0f59b0cd64d713a2" UNIQUE (id_user);


--
-- Name: compliance_accounts UQ_c35c678902b4d9d45b2ce2e1bf3; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compliance_accounts
    ADD CONSTRAINT "UQ_c35c678902b4d9d45b2ce2e1bf3" UNIQUE (id_user);


--
-- Name: IDX_8decd83b4b9593f5219e5f3085; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_8decd83b4b9593f5219e5f3085" ON public.admin_audit USING btree (target_id);


--
-- Name: IDX_c66cdd8ff785489360e3d07aee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_c66cdd8ff785489360e3d07aee" ON public.suspicious_activity_reports USING btree (account_id);


--
-- Name: idx_admin_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_created ON public.admin_audit USING btree (created_at);


--
-- Name: idx_compliance_tx_account_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_compliance_tx_account_time ON public.compliance_transactions USING btree (account_id, occurred_at);


--
-- Name: idx_compliance_tx_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_compliance_tx_time ON public.compliance_transactions USING btree (occurred_at);


--
-- Name: idx_compliance_tx_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_compliance_tx_unique ON public.compliance_transactions USING btree (transaction_id, account_id);


--
-- Name: idx_sar_status_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sar_status_time ON public.suspicious_activity_reports USING btree (status, created_at);


--
-- PostgreSQL database dump complete
--


