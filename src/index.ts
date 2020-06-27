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
			params: paramMap,
			value: parsedTx.tx.value,
		}
	})
}

function epochDate(epochSecs: BigNumber): string {
	const d = new Date(epochSecs.multipliedBy(1000).toNumber())
	return `${d.toLocaleString()}`
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
		console.info(`ProposalID: ${proposalID}`)
		console.info(`Proposer: ${"https://explorer.celo.org/address/" + proposer}`)
		console.info((executed) ? `EXECUTED` : `EXPIRED`)
		return
	}

	const propJSON = await proposalToJSON(kit, record.proposal)

	const durations = await governance.stageDurations()
	const propEpoch = record.metadata.timestamp
	const referrendumEpoch = propEpoch.plus(durations.Approval)
	const executionEpoch = referrendumEpoch.plus(durations.Referendum)
	const expirationEpoch = executionEpoch.plus(durations.Execution)

	const proposerURL = "https://explorer.celo.org/address/" + record.metadata.proposer
	console.info(`ProposalID: ${proposalID}`)
	console.info(`Proposer: ${proposerURL}`)
	console.info(`Description: ${record.metadata.descriptionURL}`)

	const stage = record.stage
	if (stage === ProposalStage.Queued) {
		console.info(`Stage:      ${stage}`)
		console.info(`Proposed:   ${epochDate(propEpoch)}`)
		console.info(`Expires:    ${epochDate(expirationEpoch)}`)
		console.info(`UpVotes:    ${record.upvotes.div(1e18).toFixed(18)}`)
	} else {
		console.info(`Stage:      ${stage}`)
		console.info(`Dequeued:   ${epochDate(propEpoch)}`)
		if (stage === ProposalStage.Approval) {
			console.info(`Referendum: ${epochDate(referrendumEpoch)}`)
		}
		if (stage === ProposalStage.Approval || stage === ProposalStage.Referendum) {
			console.info(`Execution:  ${epochDate(executionEpoch)}`)
		}
		const isApproved = await governance.isApproved(proposalID)
		console.info(`Approved:   ${String(isApproved).toUpperCase()}`)
		if (stage === ProposalStage.Approval) {
			console.info(`Passing:    FALSE (voting hasn't started yet!)`)
		} else if (isApproved) {
			const constitution = await governance.getConstitution(record.proposal)
			console.info(`Passing:    ${String(record.passing).toUpperCase()}, Threshold: ${constitution.multipliedBy(100)}%`)
			const total = record.votes.Yes.plus(record.votes.No).plus(record.votes.Abstain)
			const pctYes = record.votes.Yes.multipliedBy(100).dividedToIntegerBy(total)
			const pctNo = record.votes.No.multipliedBy(100).dividedToIntegerBy(total)
			const pctAbst = record.votes.Abstain.multipliedBy(100).dividedToIntegerBy(total)
			const totalLocked = await lockedGold.getTotalLockedGold()

			const params = await governance.getParticipationParameters()
			const totalNeeded = constitution.multipliedBy(BigNumber.maximum(total, totalLocked.multipliedBy(params.baseline)))
			const moreNeeded = BigNumber.maximum(totalNeeded.minus(record.votes.Yes), 0)

			console.info(
				`  YES:      ${pctYes.toString().padStart(3)}% - ${record.votes.Yes.div(1e18).toFixed(2)} ` +
				`(Needs ${moreNeeded.div(1e18).toFixed(2)} more to pass)`)
			console.info(`  NO:       ${pctNo.toString().padStart(3)}% - ${record.votes.No.div(1e18).toFixed(2)}`)
			console.info(`  ABSTAIN:  ${pctAbst.toString().padStart(3)}% - ${record.votes.Abstain.div(1e18).toFixed(2)}`)
		}
	}

	console.info(``)
	for (let idx = 0; idx < record.proposal.length; idx += 1) {
		const tx = propJSON[idx]
		const params: string[] = []
		for (const k of Object.keys(tx.params)) {
			params.push(`${k}=${tx.params[k]}`)
		}
		let paramsMsg = ""
		if (params.length === 1) {
			paramsMsg = params[0]
		} else if (params.length > 1) {
			paramsMsg = "\n    " + params.join(",\n    ") + ",\n"
		}
		console.info(`${tx.contract}.${tx.function}(${paramsMsg})`)
	}
}

async function listProposals(kit: ContractKit) {
	const governance = await kit.contracts.getGovernance()
	const pastQueue = await governance.getDequeue(true)
	if (pastQueue.length > 0) {
		console.info(`Proposals (${pastQueue.length}):`)
		for (const proposalID of pastQueue) {
			const expired = await governance.isDequeuedProposalExpired(proposalID)
			const stage = await governance.getProposalStage(proposalID)
			let msg = `ID: ${proposalID} - ${stage}`
			if (expired) {
				msg += ` (EXPIRED)`
			}
			console.info(msg)
		}
	}

	const queue = await governance.getQueue()
	if (queue.length > 0) {
		console.info(``)
		console.info(`Queued (${queue.length}):`)
		for (const q of queue) {
			const expired = await governance.isQueuedProposalExpired(q.proposalID)
			let msg = `ID: ${q.proposalID}, UpVotes: ${q.upvotes.div(1e18).toFixed(18)}`
			if (expired) {
				msg += " (EXPIRED)"
			}
			console.info(msg)
		}
	}
}

async function listExecutedProposals(kit: ContractKit) {
	const governanceDirect = await kit._web3Contracts.getGovernance()
	const eventLog = await governanceDirect.getPastEvents('ProposalExecuted', {fromBlock: 0})
	console.info("Executed proposals:")
	for (const event of eventLog) {
		const pId = new BigNumber(event.returnValues.proposalId)
		console.info(`ID: ${pId.toString()}, Block: @${event.blockNumber}, https://explorer.celo.org/tx/${event.transactionHash}`)
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
