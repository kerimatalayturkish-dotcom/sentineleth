-- Migration: Enable pgcrypto before any tables use gen_random_uuid().

create extension if not exists pgcrypto;