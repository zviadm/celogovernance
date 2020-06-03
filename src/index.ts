#!/usr/bin/env node
import { newKit, ContractKit, CeloContract } from '@celo/contractkit'
import commander from 'commander';
import BigNumber from 'bignumber.js'
import { obtainKitContractDetails } from '@celo/contractkit/lib/explorer/base'
import { BlockExplorer } from '@celo/contractkit/lib/explorer/block-explorer'
import { Proposal, ProposalTransaction, ProposalStage, VoteValue } from '@celo/contractkit/lib/wrappers/Governance';
import { Transaction } from 'web3-eth'
import { concurrentMap } from '@celo/utils/lib/async'


const program = commander.program
	// tslint:disable-next-line: no-var-requires
	.version(require('../package.json').version)
	.description("Parse and read CELO governance proposals.")
	.option("-n --network <url>", "CELO url to connect to.", "https://rc1-forno.celo-testnet.org")
	.option("-i --proposalID <number>", "Governance Proposal ID")
	.option("--history", "List or view already executed Governane proposals", false)
	.parse(process.argv);


process.on('unhandledRejection', (reason, _promise) => {
	// @ts-ignore
	console.error('Unhandled Rejection at:', reason.stack || reason)
	process.exit(0)
})

export interface ProposalTransactionJSON {
	contract: CeloContract
	function: string
	params: Record<string, any>
	value: string
}

export const proposalToJSON = async (kit: ContractKit, proposal: Proposal) => {
	const contractDetails = await obtainKitContractDetails(kit)
	const accounts = await kit.contracts.getAccounts()
	const blockExplorer = new BlockExplorer(kit, contractDetails)
	const contractAddresses = new Map(contractDetails.map((cd) => [cd.address, cd]))

	return concurrentMap<ProposalTransaction, ProposalTransactionJSON>(4, proposal, async (tx) => {
		const parsedTx = blockExplorer.tryParseTx(tx as Transaction)
		if (parsedTx == null) {
			throw new Error(`Unable to parse ${tx} with block explorer`)
		}
		const paramMap = parsedTx.callDetails.paramMap
		if (Object.keys(paramMap).length !== parsedTx.callDetails.argList.length) {
			throw new Error(
				`Length of parameters ${Object.keys(paramMap).length} ` +
				`doesn't match length of arguments ${parsedTx.callDetails.argList.length}`)
		}
		for (let k = 0; k < paramMap.length; k += 1) {
			const v = paramMap[k]
			if (typeof v !== "string") {
				continue
			}
			if (!v.startsWith("0x") || v.length !== 42) {
				continue
			}
			// Most likely this is an address, try to give some more meaning to it.
			const cd = contractAddresses.get(v)
			if (cd) {
				paramMap[k] = `contract.${cd.name}:${v}`
			} else if (await accounts.isAccount(v)) {
				const accountName = await accounts.getName(v)
				paramMap[k] = `account.${accountName}:${v}`
			}
		}
		return {
			contract: parsedTx.callDetails.contract as CeloContract,
			function: parsedTx.callDetails.function,
			params: parsedTx.callDetails.paramMap,
			value: parsedTx.tx.value,
		}
	})
}

function epochDate(epochSecs: BigNumber): string {
	const d = new Date(epochSecs.multipliedBy(1000).toNumber())
	return `${d.toUTCString()}`
}

async function viewProposal(kit: ContractKit, proposalID: BigNumber) {
	const governance = await kit.contracts.getGovernance()
	const lockedGold = await kit.contracts.getLockedGold()
	const record = await governance.getProposalRecord(proposalID)
	if (record.stage === ProposalStage.Expiration) {
		// check if there is history.
		const governanceDirect = await kit._web3Contracts.getGovernance()
		const eventLog = await governanceDirect.getPastEvents('ProposalQueued', {fromBlock: 0})
		const event = eventLog.find((e) => new BigNumber(e.returnValues.proposalId).eq(proposalID))
		if (!event) {
			throw new Error(`Proposal ${proposalID.toString()} was not found`)
		}
		const executedLog = await governanceDirect.getPastEvents('ProposalExecuted', {fromBlock: event.blockNumber})
		const executed = executedLog.find((e) => new BigNumber(e.returnValues.proposalId).eq(proposalID))

		const proposer: string = event.returnValues.proposer
		console.debug(`ProposalID: ${proposalID}`)
		console.debug(`Proposer: ${"https://explorer.celo.org/address/" + proposer}`)
		console.debug((executed) ? `EXECUTED` : `EXPIRED`)
		return
	}

	const propJSON = await proposalToJSON(kit, record.proposal)

	const durations = await governance.stageDurations()
	const propEpoch = record.metadata.timestamp
	const referrendumEpoch = propEpoch.plus(durations.Approval)
	const executionEpoch = referrendumEpoch.plus(durations.Referendum)
	const expirationEpoch = executionEpoch.plus(durations.Execution)

	const proposerURL = "https://explorer.celo.org/address/" + record.metadata.proposer
	console.debug(`ProposalID: ${proposalID}`)
	console.debug(`Proposer: ${proposerURL}`)
	console.debug(`Description: ${record.metadata.descriptionURL}`)

	const stage = record.stage
	if (stage === ProposalStage.Queued) {
		console.debug(`Stage:      ${stage}`)
		console.debug(`Proposed:   ${epochDate(propEpoch)}`)
		console.debug(`Expires:    ${epochDate(expirationEpoch)}`)
		console.debug(`UpVotes:    ${record.upvotes.div(1e18).toFixed(18)}`)
	} else {
		console.debug(`Stage:      ${stage}`)
		console.debug(`Dequeued:   ${epochDate(propEpoch)}`)
		if (stage === ProposalStage.Approval) {
			console.debug(`Referendum: ${epochDate(referrendumEpoch)}`)
		}
		if (stage === ProposalStage.Approval || stage === ProposalStage.Referendum) {
			console.debug(`Execution:  ${epochDate(executionEpoch)}`)
		}
		const isApproved = await governance.isApproved(proposalID)
		console.debug(`Approved:   ${String(isApproved).toUpperCase()}`)
		if (stage === ProposalStage.Approval) {
			console.debug(`Passing:    FALSE (voting hasn't started yet!)`)
		} else if (isApproved) {
			console.debug(`Passing:    ${String(record.passing).toUpperCase()}`)
			const total = record.votes.Yes.plus(record.votes.No).plus(record.votes.Abstain)
			const pctYes = record.votes.Yes.multipliedBy(100).dividedToIntegerBy(total)
			const pctNo = record.votes.No.multipliedBy(100).dividedToIntegerBy(total)
			const pctAbst = record.votes.Abstain.multipliedBy(100).dividedToIntegerBy(total)

			const totalLocked = await lockedGold.getTotalLockedGold()
			const totalPct = total.multipliedBy(100).dividedToIntegerBy(totalLocked)

			const params = await governance.getParticipationParameters()
			const baselinePct = params.baseline.multipliedBy(100).integerValue()
			const constitution = await governance.getConstitution(record.proposal)
			const pctYesNeeded = constitution.multipliedBy(100)

			console.debug(`  TOTAL:   ${totalPct}% (Needs ${baselinePct}%) - ${total.div(1e18).toFixed(18)} out of ${totalLocked.div(1e18).toFixed(18)}`)
			console.debug(`  YES:     ${pctYes}% (Needs ${pctYesNeeded}%) - ${record.votes.Yes.div(1e18).toFixed(18)}`)
			console.debug(`  NO:      ${pctNo}% - ${record.votes.No.div(1e18).toFixed(18)}`)
			console.debug(`  ABSTAIN: ${pctAbst}% - ${record.votes.Abstain.div(1e18).toFixed(18)}`)
		}
	}

	console.debug(``)
	for (let idx = 0; idx < record.proposal.length; idx += 1) {
		const tx = propJSON[idx]
		const params: string[] = []
		for (let k = 0; k < tx.params.length; k += 1) {
			params.push(`${k}=${tx.params[k]}`)
		}
		let paramsMsg = ""
		if (params.length === 1) {
			paramsMsg = params[0]
		} else if (params.length > 1) {
			paramsMsg = "\n    " + params.join(",\n    ") + ",\n"
		}
		console.debug(`${tx.contract}.${tx.function}(${paramsMsg})`)
	}
}

async function listProposals(kit: ContractKit) {
	const governance = await kit.contracts.getGovernance()
	const pastQueue = await governance.getDequeue(true)
	if (pastQueue.length > 0) {
		console.debug(`Proposals (${pastQueue.length}):`)
		for (const proposalID of pastQueue) {
			const expired = await governance.isDequeuedProposalExpired(proposalID)
			const stage = await governance.getProposalStage(proposalID)
			let msg = `ID: ${proposalID} - ${stage}`
			if (expired) {
				msg += ` (EXPIRED)`
			}
			console.debug(msg)
		}
	}

	const queue = await governance.getQueue()
	if (queue.length > 0) {
		console.debug(``)
		console.debug(`Queued (${queue.length}):`)
		for (const q of queue) {
			const expired = await governance.isQueuedProposalExpired(q.proposalID)
			let msg = `ID: ${q.proposalID}, UpVotes: ${q.upvotes.div(1e18).toFixed(18)}`
			if (expired) {
				msg += " (EXPIRED)"
			}
			console.debug(msg)
		}
	}
}

async function listExecutedProposals(kit: ContractKit) {
	const governanceDirect = await kit._web3Contracts.getGovernance()
	const eventLog = await governanceDirect.getPastEvents('ProposalExecuted', {fromBlock: 0})
	console.debug("Executed proposals:")
	for (const event of eventLog) {
		const pId = new BigNumber(event.returnValues.proposalId)
		console.debug(`ID: ${pId.toString()}, Block: @${event.blockNumber}, https://explorer.celo.org/tx/${event.transactionHash}`)
	}
}

async function main() {
	const opts = program.opts()
	const kit = newKit(opts.network)
	if (opts.proposalID) {
		await viewProposal(kit, new BigNumber(opts.proposalID))
		return
	}
	if (opts.history) {
		await listExecutedProposals(kit)
		return
	}
	listProposals(kit)
}

main()
