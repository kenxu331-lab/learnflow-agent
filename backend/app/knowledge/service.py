"""S2-A scheduler, extraction validation and local query service."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from app.core.config import Settings
from app.knowledge.errors import KnowledgeServiceError
from app.knowledge.extractor import KnowledgeExtractor
from app.knowledge.schemas import ClaimVerificationInput, ExtractionOutputDraft
from app.knowledge.store import KnowledgeStore
from app.knowledge.verifier import KnowledgeVerifier
from app.llm.errors import LLMProviderError
from app.notes.resolver import NoteResolver


class KnowledgeService:
    def __init__(
        self,
        settings: Settings,
        extractor: KnowledgeExtractor | None = None,
        store: KnowledgeStore | None = None,
        verifier: KnowledgeVerifier | None = None,
    ) -> None:
        self.settings = settings
        self.store = store or KnowledgeStore(settings)
        self.extractor = extractor or KnowledgeExtractor(settings)
        self.verifier = verifier or KnowledgeVerifier(settings)

    def status(self) -> tuple[dict[str, Any], int, int]:
        return self.store.status_counts()

    def set_consent(self, enabled: bool, policy_version: str) -> dict[str, Any]:
        return self.store.set_consent(enabled, policy_version)

    def trigger(self, chapter_id: str, conversation_id: str) -> dict[str, int | str]:
        scheduled = self.store.schedule_manual(chapter_id, conversation_id)
        if scheduled:
            return {"scheduledJobCount": scheduled, "state": "queued"}
        state = self.store.latest_job_state(conversation_id)
        if state in {"completed", "skipped"}:
            return {"scheduledJobCount": 0, "state": "no_new_events"}
        if state in {"queued", "running", "needs_review"}:
            return {"scheduledJobCount": 0, "state": state}
        return {"scheduledJobCount": 0, "state": "no_new_events"}

    def debug_latest_output(self) -> dict[str, Any]:
        return self.extractor.debug_snapshot()

    async def verify_knowledge(
        self, knowledge_id: str, version: int | None = None
    ) -> dict[str, Any]:
        bundle = self.store.verification_bundle(knowledge_id, version)
        if bundle is None:
            raise KnowledgeServiceError(
                "knowledge_not_found", "未找到可核验的知识版本。", 404
            )
        claims = bundle["claims"]
        if len(claims) > self.settings.knowledge_verifier_max_claims:
            raise KnowledgeServiceError(
                "knowledge_verifier_batch_too_large",
                "单批 Claim 数量超过核验上限。",
                422,
            )
        inputs = [
            ClaimVerificationInput(
                claimId=entry["claim"]["claim_id"],
                claimText=entry["claim"]["claim_text"],
                claimKind=entry["claim"]["claim_kind"],
                evidence=[
                    {
                        "evidenceId": row["evidence_id"],
                        "sourceKind": row["source_kind"],
                        "relation": row["relation"],
                        "resolvable": bool(row["resolvable"]),
                        "excerpt": row["excerpt"],
                    }
                    for row in entry["evidence"]
                ],
            )
            for entry in claims
        ]
        run = await self.verifier.verify(inputs)
        by_claim = {
            result.claimId: result
            for result in (run.output.results if run.output else [])
        }
        updates: dict[str, tuple[str, str]] = {}
        facts: list[str] = []
        user_insights: list[str] = []
        conflict = False
        for entry in claims:
            claim = entry["claim"]
            claim_id = claim["claim_id"]
            evidence = entry["evidence"]
            result = by_claim.get(claim_id)
            if result is None:
                status = "verification_unavailable"
                reason = run.unavailable_reason or "核验结果缺失。"
            elif claim["claim_kind"] == "user_interpretation":
                has_user_message = any(
                    row["source_kind"] == "user_message" and row["resolvable"]
                    for row in evidence
                )
                if has_user_message and result.verdict == "supported":
                    status = "user_attributed"
                    user_insights.append(status)
                else:
                    status = (
                        "insufficient_evidence"
                        if not has_user_message
                        else result.verdict
                    )
                reason = result.reason
            else:
                fact_evidence = [
                    row
                    for row in evidence
                    if row["source_kind"] in {"tutorial_block", "selection"}
                    and row["resolvable"]
                    and row["relation"] == "supports"
                ]
                conflict = conflict or any(
                    row["source_kind"] in {"tutorial_block", "selection"}
                    and row["resolvable"]
                    and row["relation"] == "contradicts"
                    for row in evidence
                )
                if not fact_evidence:
                    status = "insufficient_evidence"
                    reason = "缺少可解析的教程或选区事实证据。"
                elif result is None:
                    status = "verification_unavailable"
                    reason = run.unavailable_reason or "核验结果缺失。"
                else:
                    status = result.verdict
                    reason = result.reason
            if claim["claim_kind"] != "user_interpretation":
                facts.append(status)
            updates[claim_id] = (status, reason)

        item = bundle["item"]
        anchor_unique = bool(
            item["anchor_kind"] in {"source_block", "section"}
            and item["anchor_snapshot_id"]
            and item["anchor_block_id"]
        )
        mixed = bool(facts and user_insights)
        if mixed or conflict or not anchor_unique:
            verification_status = "needs_review"
        elif user_insights and not facts:
            verification_status = "user_attributed"
        elif "verification_unavailable" in facts:
            verification_status = "verification_unavailable"
        elif "not_supported" in facts:
            verification_status = "not_supported"
        elif "partially_supported" in facts:
            verification_status = "partially_supported"
        elif "insufficient_evidence" in facts:
            verification_status = "insufficient_evidence"
        else:
            verification_status = "supported"

        if user_insights and not facts and not mixed and not conflict and anchor_unique:
            publish_status = "eligible_user_insight"
        elif facts and not mixed and not conflict and anchor_unique and all(
            status == "supported" for status in facts
        ):
            publish_status = "eligible"
        elif conflict or not anchor_unique or mixed:
            publish_status = "needs_review"
        else:
            publish_status = "not_eligible"
        gap_reason = None
        if not anchor_unique:
            gap_reason = "anchor_unresolved"
        elif conflict:
            gap_reason = "conflicting_evidence"
        elif run.unavailable_reason:
            gap_reason = "verification_unavailable"
        self.store.persist_verification(
            knowledge_id=knowledge_id,
            version=bundle["version"]["version"],
            claim_updates=updates,
            verification_status=verification_status,
            publish_status=publish_status,
            evidence_gap_reason=gap_reason,
        )
        refreshed = self.store.verification_bundle(
            knowledge_id, bundle["version"]["version"]
        )
        assert refreshed is not None
        return self._verification_response(refreshed)

    def list_publish_candidates(self) -> list[dict[str, Any]]:
        candidates = []
        for row in self.store.publish_candidate_rows():
            if not row["anchor_snapshot_id"] or not row["source_url"]:
                continue
            candidates.append(
                self._publish_candidate(
                    row,
                    self.store.evidence_ids_for_version(
                        row["knowledge_id"], row["active_version"]
                    ),
                )
            )
        return candidates

    @staticmethod
    def _publish_candidate(row: Any, evidence_ids: list[str]) -> dict[str, Any]:
        return {
            "knowledgeId": row["knowledge_id"],
            "knowledgeVersion": row["active_version"],
            "documentId": row["document_id"],
            "chapterId": row["chapter_id"],
            "sourceUrl": row["source_url"],
            "targetNoteId": row["document_id"],
            "targetRelativePath": NoteResolver()
            .resolve(row["source_url"])
            .target_relative_path,
            "sourceSnapshotId": row["anchor_snapshot_id"],
            "sourceBlockId": row["anchor_block_id"],
            "anchorStableKey": row["anchor_stable_key"],
            "headingPath": json.loads(row["heading_path_json"]),
            "anchorFingerprint": row["anchor_fingerprint"],
            "body": row["body"],
            "bodyHash": row["body_hash"],
            "kind": row["kind"],
            "verificationStatus": (
                "user_attributed"
                if row["version_publish_status"] == "eligible_user_insight"
                else "supported"
            ),
            "evidenceIds": evidence_ids,
            "publishStatus": row["version_publish_status"],
        }

    @staticmethod
    def _verification_response(bundle: dict[str, Any]) -> dict[str, Any]:
        item = bundle["item"]
        version = bundle["version"]
        claims = []
        evidence_ids: list[str] = []
        for entry in bundle["claims"]:
            claim = entry["claim"]
            ids = [row["evidence_id"] for row in entry["evidence"]]
            evidence_ids.extend(ids)
            claims.append(
                {
                    "claimId": claim["claim_id"],
                    "text": claim["claim_text"],
                    "kind": claim["claim_kind"],
                    "verificationStatus": claim["verification_status"],
                    "verificationReason": claim["verification_reason"],
                    "evidenceIds": ids,
                }
            )
        candidate = None
        if version["publish_status"] in {"eligible", "eligible_user_insight"}:
            candidate_row = dict(item)
            candidate_row.update(
                {
                    "body": version["body"],
                    "body_hash": version["body_hash"],
                    "version_publish_status": version["publish_status"],
                    "source_url": version.get("anchor_source_url"),
                }
            )
            if candidate_row["anchor_snapshot_id"] and candidate_row["source_url"]:
                candidate = KnowledgeService._publish_candidate(
                    candidate_row, sorted(set(evidence_ids))
                )
        return {
            "knowledgeId": item["knowledge_id"],
            "knowledgeVersion": version["version"],
            "verificationStatus": version["verification_status"],
            "publishStatus": version["publish_status"],
            "claims": claims,
            "publishCandidate": candidate,
        }

    async def run_once(self) -> bool:
        self.store.recover_expired_leases()
        self.store.plan_jobs()
        claimed = self.store.claim_next_job()
        if claimed is None:
            return False
        job, token = claimed
        try:
            evidence = self.store.build_registry(job)
            events = [dict(row) for row in self.store.job_rows(job["job_id"])]
            draft = await self.extractor.extract(
                job=dict(job), events=events, evidence=evidence
            )
            self._validate_draft(draft, evidence, job)
            self.store.persist_drafts(job, token, draft, evidence)
        except LLMProviderError as error:
            self.store.fail_job(job, token, error.code, error.message, retryable=True)
        except KnowledgeServiceError as error:
            self.store.fail_job(job, token, error.code, error.message, retryable=False)
        except Exception:
            self.store.fail_job(
                job,
                token,
                "knowledge_internal_error",
                "知识提炼任务处理失败。",
                retryable=False,
            )
        return True

    @staticmethod
    def _validate_draft(
        draft: ExtractionOutputDraft,
        evidence: dict[str, Any],
        job: Any,
    ) -> None:
        del job
        for candidate in draft.candidates:
            if not candidate.worthExtracting:
                continue
            if (
                candidate.anchorEvidenceId
                and candidate.anchorEvidenceId not in evidence
            ):
                raise KnowledgeServiceError(
                    "knowledge_unknown_evidence",
                    "知识候选引用了不存在的锚点证据。",
                    422,
                )
            for claim in candidate.claims:
                referenced = {
                    evidence_id
                    for ref in claim.evidence
                    for evidence_id in ref.evidenceIds
                }
                if not referenced.issubset(evidence):
                    raise KnowledgeServiceError(
                        "knowledge_unknown_evidence",
                        "知识候选引用了不存在的证据。",
                        422,
                    )
                if claim.kind == "tutorial_fact":
                    supporting = [
                        evidence[evidence_id]
                        for ref in claim.evidence
                        if ref.relation == "supports"
                        for evidence_id in ref.evidenceIds
                    ]
                    if not any(
                        row["source_kind"] in {"tutorial_block", "selection"}
                        and row["resolvable"]
                        for row in supporting
                    ):
                        raise KnowledgeServiceError(
                            "knowledge_missing_fact_evidence",
                            "事实性知识缺少可解析教程证据。",
                            422,
                        )
                if candidate.kind == "user_insight" and not any(
                    evidence[evidence_id]["source_kind"] == "user_message"
                    for evidence_id in referenced
                ):
                    raise KnowledgeServiceError(
                        "knowledge_missing_user_evidence",
                        "个人理解缺少对应用户消息。",
                        422,
                    )

    async def worker(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            await self.run_once()
            try:
                await asyncio.wait_for(
                    stop.wait(), timeout=self.settings.knowledge_worker_poll_seconds
                )
            except TimeoutError:
                pass
