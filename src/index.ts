#!/usr/bin/env node
import { newKit, ContractKit, CeloContract } from '@celo/contractkit'
import commander from 'commander';
import BigNumber from 'bignumber.js'
import { obtainKitContractDetails } from '@celo/contractkit/lib/explorer/base'
import { BlockExplorer } from '@celo/contractkit/lib/explorer/block-explorer'
import { Proposal, ProposalTransaction } from '@celo/contractkit/lib/wrappers/Governance';
import { Transaction } from 'web3-eth'
import { concurrentMap } from '@celo/utils/lib/async'


const program = commander.program
  .version('0.0.1')
  .description("Parse and read CELO governance proposals.")
  .option("-n --network <url>", "CELO url to connect to.", "http://127.0.0.1:8545")
  .option("-i --proposalID <number>", "Governance Proposal ID")
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
		for (const k in paramMap) {
			const v = paramMap[k]
			if (typeof v !== "string") {
				continue
			}
			if (!v.startsWith("0x") || v.length != 42) {
				continue
			}
			// Most likely this is an address, try to give some more meaning to it.
			const cd = contractAddresses.get(v)
			if (cd) {
				paramMap[k] = `contract:${cd.name}:${v}`
			} else if (await accounts.isAccount(v)) {
				const accountName = await accounts.getName(v)
				paramMap[k] = `account:${accountName}:${v}`
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

async function viewProposal(kit: ContractKit, proposalID: BigNumber) {
	const governance = await kit.contracts.getGovernance()
	const record = await governance.getProposalRecord(proposalID)
	const propJSON = await proposalToJSON(kit, record.proposal)
	console.debug(`ProposalID: ${proposalID}, Transactions: ${record.proposal.length}`)
	for (const idx in record.proposal) {
		const tx = propJSON[idx]
		const params: string[] = []
		for (let k in tx.params) {
			params.push(`    ${k} = ${tx.params[k]},`)
		}
		console.debug(`${tx.contract}.${tx.function}(\n${params.join("\n")}\n)`)
	}
}

function main() {
	const opts = program.opts()
	const kit = newKit(opts.network)
	viewProposal(
		kit,
		new BigNumber(opts.proposalID),
		).
	then(() => {
		process.exit(0)
	}).
	catch((e) => {
		console.error(e)
		process.exit(1)
	})
}

main()
